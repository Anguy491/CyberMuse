use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::http::{Method, Request, Response, StatusCode};

use crate::analysis_coordinator::new_job_id;

const CAPABILITY_LIFETIME: Duration = Duration::from_secs(6 * 60 * 60);
const MAX_RANGE_BYTES: u64 = 1000 * 1024;

fn resource_url(token: &str) -> String {
    #[cfg(any(target_os = "windows", target_os = "android"))]
    {
        format!("http://cybermuse.localhost/{token}")
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        format!("cybermuse://localhost/{token}")
    }
}

#[derive(Debug, Clone)]
struct ResourceCapability {
    song_id: String,
    analysis_id: String,
    path: PathBuf,
    expires_at: Instant,
}

#[derive(Clone, Default)]
pub struct ResourceRegistry(Arc<Mutex<HashMap<String, ResourceCapability>>>);

impl ResourceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn issue(&self, song_id: &str, analysis_id: &str, path: PathBuf) -> String {
        let token = new_job_id();
        let mut resources = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
        resources.retain(|_, capability| capability.expires_at > Instant::now());
        resources.insert(
            token.clone(),
            ResourceCapability {
                song_id: song_id.to_owned(),
                analysis_id: analysis_id.to_owned(),
                path,
                expires_at: Instant::now() + CAPABILITY_LIFETIME,
            },
        );
        resource_url(&token)
    }

    pub fn revoke_song(&self, song_id: &str) {
        self.0
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .retain(|_, capability| capability.song_id != song_id);
    }

    pub fn handle(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        self.try_handle(request).unwrap_or_else(|status| {
            Response::builder()
                .status(status)
                .header("Access-Control-Allow-Origin", "*")
                .header("Cross-Origin-Resource-Policy", "cross-origin")
                .header("Cache-Control", "no-store")
                .body(Vec::new())
                .expect("static protocol response")
        })
    }

    fn try_handle(&self, request: Request<Vec<u8>>) -> Result<Response<Vec<u8>>, StatusCode> {
        let token = request.uri().path().trim_start_matches('/');
        if !is_uuid(token) {
            return Err(StatusCode::NOT_FOUND);
        }
        let capability = self
            .0
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get(token)
            .filter(|capability| capability.expires_at > Instant::now())
            .cloned()
            .ok_or(StatusCode::NOT_FOUND)?;
        let _identity = &capability.analysis_id;
        let mut file = File::open(&capability.path).map_err(|_| StatusCode::NOT_FOUND)?;
        let len = file
            .metadata()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .len();
        if request.method() == Method::HEAD {
            return Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "audio/wav")
                .header("Content-Length", len)
                .header("Accept-Ranges", "bytes")
                .header("Access-Control-Allow-Origin", "*")
                .header("Cross-Origin-Resource-Policy", "cross-origin")
                .header("Cache-Control", "no-store")
                .body(Vec::new())
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
        }
        if request.method() != Method::GET {
            return Err(StatusCode::METHOD_NOT_ALLOWED);
        }

        let requested = request
            .headers()
            .get("range")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| parse_range(value, len));
        if request.headers().contains_key("range") && requested.is_none() {
            return Err(StatusCode::RANGE_NOT_SATISFIABLE);
        }
        let (start, end, partial) = requested
            .map(|(start, end)| (start, end.min(start + MAX_RANGE_BYTES - 1), true))
            .unwrap_or_else(|| {
                (
                    0,
                    len.saturating_sub(1).min(MAX_RANGE_BYTES - 1),
                    len > MAX_RANGE_BYTES,
                )
            });
        let count = if len == 0 { 0 } else { end + 1 - start };
        file.seek(SeekFrom::Start(start))
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let mut body = Vec::with_capacity(count as usize);
        file.take(count)
            .read_to_end(&mut body)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let mut response = Response::builder()
            .status(if partial {
                StatusCode::PARTIAL_CONTENT
            } else {
                StatusCode::OK
            })
            .header("Content-Type", "audio/wav")
            .header("Content-Length", body.len())
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Allow-Origin", "*")
            .header("Cross-Origin-Resource-Policy", "cross-origin")
            .header("Cache-Control", "no-store")
            .header("Access-Control-Expose-Headers", "Content-Range");
        if partial {
            response = response.header("Content-Range", format!("bytes {start}-{end}/{len}"));
        }
        response
            .body(body)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
    }
}

fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let range = value.strip_prefix("bytes=")?;
    if range.contains(',') || len == 0 {
        return None;
    }
    let (start, end) = range.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?.min(len);
        if suffix == 0 {
            return None;
        }
        return Some((len - suffix, len - 1));
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        len - 1
    } else {
        end.parse::<u64>().ok()?.min(len - 1)
    };
    (start < len && end >= start).then_some((start, end))
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn tc_sto_001_resource_url_is_opaque_bounded_and_revocable() {
        let path =
            std::env::temp_dir().join(format!("cybermuse-m5-resource-{}.wav", std::process::id()));
        fs::write(&path, vec![7_u8; 2_000_000]).expect("fixture");
        let registry = ResourceRegistry::new();
        let url = registry.issue(&"a".repeat(64), &"b".repeat(32), path.clone());
        assert!(!url.contains(&path.to_string_lossy().to_string()));
        #[cfg(target_os = "windows")]
        assert!(url.starts_with("http://cybermuse.localhost/"));
        let token = url.rsplit('/').next().expect("token");
        let request = Request::builder()
            .uri(format!("cybermuse://localhost/{token}"))
            .header("range", "bytes=0-")
            .body(Vec::new())
            .expect("request");
        let response = registry.handle(request);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().len(), MAX_RANGE_BYTES as usize);
        assert_eq!(
            response
                .headers()
                .get("Cross-Origin-Resource-Policy")
                .and_then(|value| value.to_str().ok()),
            Some("cross-origin")
        );
        registry.revoke_song(&"a".repeat(64));
        let request = Request::builder()
            .uri(format!("cybermuse://localhost/{token}"))
            .body(Vec::new())
            .expect("request");
        assert_eq!(registry.handle(request).status(), StatusCode::NOT_FOUND);
        let _ignored = fs::remove_file(path);
    }

    #[test]
    fn tc_voc_001_dual_stem_capabilities_are_distinct_and_revoked_together() {
        let suffix = format!("{}-{}", std::process::id(), new_job_id());
        let instrumental =
            std::env::temp_dir().join(format!("cybermuse-m9-instrumental-{suffix}.wav"));
        let vocals = std::env::temp_dir().join(format!("cybermuse-m9-vocals-{suffix}.wav"));
        fs::write(&instrumental, b"instrumental").expect("instrumental fixture");
        fs::write(&vocals, b"vocals").expect("vocals fixture");

        let song_id = "c".repeat(64);
        let analysis_id = "d".repeat(32);
        let registry = ResourceRegistry::new();
        let instrumental_url = registry.issue(&song_id, &analysis_id, instrumental.clone());
        let vocals_url = registry.issue(&song_id, &analysis_id, vocals.clone());
        assert_ne!(instrumental_url, vocals_url);
        assert!(!instrumental_url.contains(&instrumental.to_string_lossy().to_string()));
        assert!(!vocals_url.contains(&vocals.to_string_lossy().to_string()));

        let instrumental_token = instrumental_url.rsplit('/').next().expect("token");
        let vocals_token = vocals_url.rsplit('/').next().expect("token");
        {
            let resources = registry
                .0
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            for token in [instrumental_token, vocals_token] {
                let capability = resources.get(token).expect("issued capability");
                assert_eq!(capability.song_id, song_id);
                assert_eq!(capability.analysis_id, analysis_id);
            }
        }

        for url in [&instrumental_url, &vocals_url] {
            let token = url.rsplit('/').next().expect("token");
            let response = registry.handle(
                Request::builder()
                    .uri(format!("cybermuse://localhost/{token}"))
                    .header("range", "bytes=0-3")
                    .body(Vec::new())
                    .expect("request"),
            );
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(response.body().len(), 4);
            assert_eq!(response.headers()["Cache-Control"], "no-store");
            assert_eq!(
                response.headers()["Cross-Origin-Resource-Policy"],
                "cross-origin"
            );
        }

        registry
            .0
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get_mut(vocals_token)
            .expect("vocal capability")
            .expires_at = Instant::now() - Duration::from_secs(1);
        let expired_response = registry.handle(
            Request::builder()
                .uri(format!("cybermuse://localhost/{vocals_token}"))
                .body(Vec::new())
                .expect("request"),
        );
        assert_eq!(expired_response.status(), StatusCode::NOT_FOUND);

        let replacement_vocals_url = registry.issue(&song_id, &analysis_id, vocals.clone());

        registry.revoke_song(&song_id);
        for url in [&instrumental_url, &replacement_vocals_url] {
            let token = url.rsplit('/').next().expect("token");
            let response = registry.handle(
                Request::builder()
                    .uri(format!("cybermuse://localhost/{token}"))
                    .body(Vec::new())
                    .expect("request"),
            );
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }

        let _ignored = fs::remove_file(instrumental);
        let _ignored = fs::remove_file(vocals);
    }
}
