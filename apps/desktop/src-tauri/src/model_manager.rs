use std::collections::BTreeMap;
use std::fmt::Write as FmtWrite;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use ureq::Agent;
use ureq::http::Uri;

use crate::storage::{read_versioned_json, write_versioned_json};

const MAX_REDIRECTS: usize = 5;
static DIAGNOSTIC_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelError {
    pub code: &'static str,
    pub message_key: &'static str,
    pub retryable: bool,
    pub safe_details: BTreeMap<String, String>,
    pub diagnostic_id: String,
}

impl ModelError {
    fn new(code: &'static str, message_key: &'static str, retryable: bool) -> Self {
        let sequence = DIAGNOSTIC_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        Self {
            code,
            message_key,
            retryable,
            safe_details: BTreeMap::new(),
            diagnostic_id: format!("model-{}-{sequence}", std::process::id()),
        }
    }

    fn with_detail(mut self, key: &str, value: impl ToString) -> Self {
        self.safe_details.insert(key.to_owned(), value.to_string());
        self
    }

    fn consent() -> Self {
        Self::new(
            "MODEL_CONSENT_REQUIRED",
            "model.error.consentRequired",
            false,
        )
    }

    fn network() -> Self {
        Self::new("MODEL_DOWNLOAD_FAILED", "model.error.downloadFailed", true)
    }

    fn invalid() -> Self {
        Self::new(
            "MODEL_INTEGRITY_FAILED",
            "model.error.integrityFailed",
            true,
        )
    }

    fn storage() -> Self {
        Self::new("MODEL_STORAGE_FAILED", "model.error.storageFailed", true)
    }

    fn cancelled() -> Self {
        Self::new(
            "MODEL_DOWNLOAD_CANCELLED",
            "model.error.downloadCancelled",
            true,
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogEntry {
    pub schema_version: u32,
    pub model_id: String,
    pub version: String,
    pub engine: String,
    pub source_url: String,
    pub license_expression: String,
    pub license_url: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub artifact_name: String,
    pub supported_hardware: Vec<String>,
}

#[derive(Debug, Clone)]
struct ModelSpec {
    entry: ModelCatalogEntry,
    allowed_hosts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledModelManifest {
    schema_version: u32,
    model_id: String,
    version: String,
    engine: String,
    source_url: String,
    license_expression: String,
    license_url: String,
    size_bytes: u64,
    sha256: String,
    artifact_name: String,
    supported_hardware: Vec<String>,
    accepted_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub schema_version: u32,
    pub model_id: String,
    pub version: String,
    pub artifact_path: PathBuf,
    pub size_bytes: u64,
    pub sha256: String,
    pub already_installed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub schema_version: u32,
    pub model_id: String,
    pub version: String,
    pub display_name: String,
    pub purpose: String,
    pub source_url: String,
    pub license_expression: String,
    pub license_url: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub installed: bool,
    pub valid: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelInstallStage {
    Downloading,
    Verifying,
    Installing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInstallProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub status: ModelInstallStage,
}

fn specs() -> Vec<ModelSpec> {
    vec![
        ModelSpec {
            entry: ModelCatalogEntry {
                schema_version: 1,
                model_id: "spleeter-2stems".to_owned(),
                version: "1.4.0".to_owned(),
                engine: "tensorflow-cpu".to_owned(),
                source_url:
                    "https://github.com/deezer/spleeter/releases/download/v1.4.0/2stems.tar.gz"
                        .to_owned(),
                license_expression: "MIT".to_owned(),
                license_url: "https://github.com/deezer/spleeter/blob/master/LICENSE".to_owned(),
                size_bytes: 73_109_797,
                sha256: "f3a90b39dd2874269e8b05a48a86745df897b848c61f3958efc80a39152bd692"
                    .to_owned(),
                artifact_name: "2stems.tar.gz".to_owned(),
                supported_hardware: vec!["cpu-x86_64".to_owned()],
            },
            allowed_hosts: vec![
                "github.com".to_owned(),
                "objects.githubusercontent.com".to_owned(),
                "release-assets.githubusercontent.com".to_owned(),
            ],
        },
        ModelSpec {
            entry: ModelCatalogEntry {
                schema_version: 1,
                model_id: "swiftf0".to_owned(),
                version: "0.1.2".to_owned(),
                engine: "onnxruntime-cpu".to_owned(),
                source_url: "https://files.pythonhosted.org/packages/eb/65/029ed8e87f77f5c1b171f6387e9c99509f1385c9d9a3c50b844c45bd26b4/swift_f0-0.1.2-py3-none-any.whl".to_owned(),
                license_expression: "MIT".to_owned(),
                license_url: "https://github.com/lars76/swift-f0/blob/main/LICENSE".to_owned(),
                size_bytes: 379_040,
                sha256: "212715116025a490be70db0afda8fb27b1eadf267a3b18ed8df4866c1574e717"
                    .to_owned(),
                artifact_name: "swift_f0-0.1.2-py3-none-any.whl".to_owned(),
                supported_hardware: vec!["cpu-x86_64".to_owned()],
            },
            allowed_hosts: vec!["files.pythonhosted.org".to_owned()],
        },
    ]
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    let bytes = bytes.as_ref();
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}

pub fn model_catalog() -> Vec<ModelCatalogEntry> {
    specs().into_iter().map(|spec| spec.entry).collect()
}

fn find_spec(model_id: &str, version: &str) -> Result<ModelSpec, ModelError> {
    specs()
        .into_iter()
        .find(|spec| spec.entry.model_id == model_id && spec.entry.version == version)
        .ok_or_else(|| {
            ModelError::new("MODEL_NOT_APPROVED", "model.error.notApproved", false)
                .with_detail("modelId", model_id)
                .with_detail("version", version)
        })
}

fn sha256_reader(mut reader: impl Read) -> Result<(String, u64), ModelError> {
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 128 * 1024];
    let mut size = 0_u64;
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|_| ModelError::storage())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        size = size
            .checked_add(u64::try_from(count).map_err(|_| ModelError::invalid())?)
            .ok_or_else(ModelError::invalid)?;
    }
    Ok((hex_digest(digest.finalize()), size))
}

fn validate_host(url: &str, allowed_hosts: &[String], allow_http: bool) -> Result<(), ModelError> {
    let uri: Uri = url.parse().map_err(|_| ModelError::network())?;
    let scheme = uri.scheme_str().unwrap_or_default();
    if (scheme != "https" && !(allow_http && scheme == "http"))
        || !allowed_hosts
            .iter()
            .any(|host| Some(host.as_str()) == uri.host())
        || uri
            .authority()
            .is_some_and(|authority| authority.as_str().contains('@'))
    {
        return Err(ModelError::network().with_detail("reason", "host_not_allowed"));
    }
    Ok(())
}

struct DownloadExpectation<'a> {
    allowed_hosts: &'a [String],
    size_bytes: u64,
    expected_sha256: &'a str,
    allow_http: bool,
}

fn download_verified_controlled(
    source_url: &str,
    destination: &Path,
    expectation: DownloadExpectation<'_>,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<(), ModelError> {
    let config = Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(900)))
        .https_only(!expectation.allow_http)
        .max_redirects(0)
        .http_status_as_error(false)
        .proxy(None)
        .user_agent("CyberMuse/0.1 model-installer")
        .build();
    let agent = Agent::new_with_config(config);
    let mut url = source_url.to_owned();
    let mut redirects = 0_usize;
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(ModelError::cancelled());
        }
        validate_host(&url, expectation.allowed_hosts, expectation.allow_http)?;
        let mut response = agent.get(&url).call().map_err(|_| ModelError::network())?;
        let status = response.status().as_u16();
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            if redirects >= MAX_REDIRECTS {
                return Err(ModelError::network().with_detail("reason", "redirect_limit"));
            }
            let location = response
                .headers()
                .get("location")
                .and_then(|value| value.to_str().ok())
                .ok_or_else(ModelError::network)?;
            validate_host(location, expectation.allowed_hosts, expectation.allow_http)?;
            url = location.to_owned();
            redirects += 1;
            continue;
        }
        if status != 200 {
            return Err(ModelError::network().with_detail("httpStatus", status));
        }
        if response
            .body()
            .content_length()
            .is_some_and(|size| size != expectation.size_bytes)
        {
            return Err(ModelError::invalid().with_detail("reason", "content_length"));
        }
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination)
            .map_err(|_| ModelError::storage())?;
        let mut digest = Sha256::new();
        let mut size = 0_u64;
        let mut buffer = [0_u8; 128 * 1024];
        let mut reader = response.body_mut().as_reader();
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(ModelError::cancelled());
            }
            let count = reader
                .read(&mut buffer)
                .map_err(|_| ModelError::network())?;
            if count == 0 {
                break;
            }
            size = size
                .checked_add(u64::try_from(count).map_err(|_| ModelError::invalid())?)
                .ok_or_else(ModelError::invalid)?;
            if size > expectation.size_bytes {
                return Err(ModelError::invalid().with_detail("reason", "oversize"));
            }
            digest.update(&buffer[..count]);
            file.write_all(&buffer[..count])
                .map_err(|_| ModelError::storage())?;
            on_progress(size, expectation.size_bytes);
        }
        file.sync_all().map_err(|_| ModelError::storage())?;
        let actual_hash = hex_digest(digest.finalize());
        if size != expectation.size_bytes || actual_hash != expectation.expected_sha256 {
            return Err(ModelError::invalid().with_detail("reason", "size_or_hash"));
        }
        return Ok(());
    }
}

#[cfg(test)]
fn download_verified(
    source_url: &str,
    allowed_hosts: &[String],
    size_bytes: u64,
    expected_sha256: &str,
    destination: &Path,
    allow_http: bool,
) -> Result<(), ModelError> {
    download_verified_controlled(
        source_url,
        destination,
        DownloadExpectation {
            allowed_hosts,
            size_bytes,
            expected_sha256,
            allow_http,
        },
        &AtomicBool::new(false),
        |_, _| {},
    )
}

fn installed_manifest(spec: &ModelSpec) -> Result<InstalledModelManifest, ModelError> {
    let accepted_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| ModelError::storage())?;
    Ok(InstalledModelManifest {
        schema_version: 1,
        model_id: spec.entry.model_id.clone(),
        version: spec.entry.version.clone(),
        engine: spec.entry.engine.clone(),
        source_url: spec.entry.source_url.clone(),
        license_expression: spec.entry.license_expression.clone(),
        license_url: spec.entry.license_url.clone(),
        size_bytes: spec.entry.size_bytes,
        sha256: spec.entry.sha256.clone(),
        artifact_name: spec.entry.artifact_name.clone(),
        supported_hardware: spec.entry.supported_hardware.clone(),
        accepted_at,
    })
}

fn validate_existing(spec: &ModelSpec, final_directory: &Path) -> Result<bool, ModelError> {
    if !final_directory.exists() {
        return Ok(false);
    }
    let current_manifest = final_directory.join("model-manifest.json");
    let manifest_path = if current_manifest.is_file() {
        current_manifest
    } else {
        // M4 development previews used model.json. Accept an intact legacy
        // manifest read-only; every new installation writes the final name.
        final_directory.join("model.json")
    };
    let manifest: InstalledModelManifest =
        read_versioned_json(&manifest_path).map_err(|_| ModelError::invalid())?;
    if manifest.model_id != spec.entry.model_id
        || manifest.version != spec.entry.version
        || manifest.sha256 != spec.entry.sha256
        || manifest.size_bytes != spec.entry.size_bytes
        || manifest.artifact_name != spec.entry.artifact_name
    {
        return Err(ModelError::invalid().with_detail("reason", "installed_manifest"));
    }
    let artifact = final_directory.join(&manifest.artifact_name);
    let (hash, size) = sha256_reader(File::open(artifact).map_err(|_| ModelError::invalid())?)?;
    if hash != spec.entry.sha256 || size != spec.entry.size_bytes {
        return Err(ModelError::invalid().with_detail("reason", "installed_artifact"));
    }
    Ok(true)
}

fn install_spec(
    spec: &ModelSpec,
    model_root: &Path,
    confirmed_sha256: &str,
    allow_http: bool,
    download_root: &Path,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(ModelInstallProgress),
) -> Result<InstalledModel, ModelError> {
    if confirmed_sha256 != spec.entry.sha256 {
        return Err(ModelError::consent());
    }
    fs::create_dir_all(model_root).map_err(|_| ModelError::storage())?;
    let model_directory = model_root.join(&spec.entry.model_id);
    fs::create_dir_all(&model_directory).map_err(|_| ModelError::storage())?;
    let final_directory = model_directory.join(&spec.entry.version);
    if validate_existing(spec, &final_directory)? {
        return Ok(InstalledModel {
            schema_version: 1,
            model_id: spec.entry.model_id.clone(),
            version: spec.entry.version.clone(),
            artifact_path: final_directory.join(&spec.entry.artifact_name),
            size_bytes: spec.entry.size_bytes,
            sha256: spec.entry.sha256.clone(),
            already_installed: true,
        });
    }
    fs::create_dir_all(download_root).map_err(|_| ModelError::storage())?;
    let temp_directory = download_root.join(format!(
        "{}-{}.download-{}-{}",
        spec.entry.model_id,
        spec.entry.version,
        std::process::id(),
        DIAGNOSTIC_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&temp_directory).map_err(|_| ModelError::storage())?;
    let artifact = temp_directory.join(&spec.entry.artifact_name);
    let result = (|| {
        download_verified_controlled(
            &spec.entry.source_url,
            &artifact,
            DownloadExpectation {
                allowed_hosts: &spec.allowed_hosts,
                size_bytes: spec.entry.size_bytes,
                expected_sha256: &spec.entry.sha256,
                allow_http,
            },
            cancel,
            |downloaded_bytes, total_bytes| {
                on_progress(ModelInstallProgress {
                    downloaded_bytes,
                    total_bytes,
                    status: ModelInstallStage::Downloading,
                });
            },
        )?;
        on_progress(ModelInstallProgress {
            downloaded_bytes: spec.entry.size_bytes,
            total_bytes: spec.entry.size_bytes,
            status: ModelInstallStage::Verifying,
        });
        write_versioned_json(
            &temp_directory.join("model-manifest.json"),
            &installed_manifest(spec)?,
        )
        .map_err(|_| ModelError::storage())?;
        on_progress(ModelInstallProgress {
            downloaded_bytes: spec.entry.size_bytes,
            total_bytes: spec.entry.size_bytes,
            status: ModelInstallStage::Installing,
        });
        fs::rename(&temp_directory, &final_directory).map_err(|_| ModelError::storage())?;
        Ok(InstalledModel {
            schema_version: 1,
            model_id: spec.entry.model_id.clone(),
            version: spec.entry.version.clone(),
            artifact_path: final_directory.join(&spec.entry.artifact_name),
            size_bytes: spec.entry.size_bytes,
            sha256: spec.entry.sha256.clone(),
            already_installed: false,
        })
    })();
    if result.is_err() {
        let _ignored = fs::remove_dir_all(&temp_directory);
    }
    result
}

pub fn install_model(
    model_root: &Path,
    model_id: &str,
    version: &str,
    confirmed_sha256: &str,
) -> Result<InstalledModel, ModelError> {
    let spec = find_spec(model_id, version)?;
    let download_root = model_root
        .parent()
        .unwrap_or(model_root)
        .join("tmp")
        .join("downloads");
    install_spec(
        &spec,
        model_root,
        confirmed_sha256,
        false,
        &download_root,
        &AtomicBool::new(false),
        |_| {},
    )
}

pub fn install_model_controlled(
    model_root: &Path,
    download_root: &Path,
    model_id: &str,
    version: &str,
    confirmed_sha256: &str,
    cancel: &AtomicBool,
    on_progress: impl FnMut(ModelInstallProgress),
) -> Result<InstalledModel, ModelError> {
    let spec = find_spec(model_id, version)?;
    install_spec(
        &spec,
        model_root,
        confirmed_sha256,
        false,
        download_root,
        cancel,
        on_progress,
    )
}

pub fn model_statuses(model_root: &Path) -> Vec<ModelStatus> {
    specs()
        .into_iter()
        .map(|spec| {
            let final_directory = model_root
                .join(&spec.entry.model_id)
                .join(&spec.entry.version);
            let (installed, valid) = if final_directory.exists() {
                (
                    true,
                    validate_existing(&spec, &final_directory).unwrap_or(false),
                )
            } else {
                (false, false)
            };
            let (display_name, purpose) = match spec.entry.model_id.as_str() {
                "spleeter-2stems" => ("Spleeter 2 stems", "人声与伴奏分离"),
                "swiftf0" => ("SwiftF0", "连续歌声音高估计"),
                _ => ("Approved model", "本地歌曲分析"),
            };
            ModelStatus {
                schema_version: 1,
                model_id: spec.entry.model_id,
                version: spec.entry.version,
                display_name: display_name.to_owned(),
                purpose: purpose.to_owned(),
                source_url: spec.entry.source_url,
                license_expression: spec.entry.license_expression,
                license_url: spec.entry.license_url,
                size_bytes: spec.entry.size_bytes,
                sha256: spec.entry.sha256,
                installed,
                valid,
            }
        })
        .collect()
}

pub fn remove_model(model_root: &Path, model_id: &str, version: &str) -> Result<bool, ModelError> {
    let spec = find_spec(model_id, version)?;
    let path = model_root
        .join(&spec.entry.model_id)
        .join(&spec.entry.version);
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_dir_all(path).map_err(|_| ModelError::storage())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;

    use super::*;

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "cybermuse-m4-model-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn hash(bytes: &[u8]) -> String {
        hex_digest(Sha256::digest(bytes))
    }

    fn serve_once(bytes: Vec<u8>) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
        let address = listener.local_addr().expect("test address should exist");
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("request should arrive");
            let mut request = [0_u8; 2048];
            let count = stream.read(&mut request).expect("request should read");
            assert!(String::from_utf8_lossy(&request[..count]).starts_with("GET /model.bin"));
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            )
            .expect("headers should write");
            stream.write_all(&bytes).expect("body should write");
        });
        (format!("http://{address}/model.bin"), handle)
    }

    fn serve_responses(responses: Vec<Vec<u8>>) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
        let address = listener.local_addr().expect("test address should exist");
        let handle = thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().expect("request should arrive");
                let mut request = [0_u8; 2048];
                let _count = stream.read(&mut request).expect("request should read");
                stream.write_all(&response).expect("response should write");
            }
        });
        (format!("http://{address}"), handle)
    }

    fn local_spec(url: String, bytes: &[u8]) -> ModelSpec {
        ModelSpec {
            entry: ModelCatalogEntry {
                schema_version: 1,
                model_id: "local-fixture".to_owned(),
                version: "1.0.0".to_owned(),
                engine: "fixture".to_owned(),
                source_url: url,
                license_expression: "MIT".to_owned(),
                license_url: "https://example.invalid/license".to_owned(),
                size_bytes: u64::try_from(bytes.len()).expect("fixture size should fit"),
                sha256: hash(bytes),
                artifact_name: "model.bin".to_owned(),
                supported_hardware: vec!["cpu-x86_64".to_owned()],
            },
            allowed_hosts: vec!["127.0.0.1".to_owned()],
        }
    }

    #[test]
    fn tc_mod_001_requires_exact_consent_without_network() {
        let root = test_root("consent");
        let bytes = b"approved model";
        let spec = local_spec("http://127.0.0.1:9/model.bin".to_owned(), bytes);
        let download_root = root.join("tmp").join("downloads");
        let error = install_spec(
            &spec,
            &root,
            "wrong",
            true,
            &download_root,
            &AtomicBool::new(false),
            |_| {},
        )
        .expect_err("consent must fail");
        assert_eq!(error.code, "MODEL_CONSENT_REQUIRED");
        assert!(!root.exists());
    }

    #[test]
    fn tc_mod_001_downloads_validates_reuses_offline_and_removes() {
        let root = test_root("install");
        let bytes = b"approved local model".to_vec();
        let (url, server) = serve_once(bytes.clone());
        let spec = local_spec(url, &bytes);
        let download_root = root.join("tmp").join("downloads");
        let installed = install_spec(
            &spec,
            &root,
            &spec.entry.sha256,
            true,
            &download_root,
            &AtomicBool::new(false),
            |_| {},
        )
        .expect("local download should install");
        server.join().expect("server should finish");
        assert_eq!(
            fs::read(&installed.artifact_path).expect("artifact should read"),
            bytes
        );
        assert!(!installed.already_installed);

        let reused = install_spec(
            &spec,
            &root,
            &spec.entry.sha256,
            true,
            &download_root,
            &AtomicBool::new(false),
            |_| {},
        )
        .expect("installed artifact should be reused without a server");
        assert!(reused.already_installed);
        let removed = root.join("local-fixture").join("1.0.0");
        fs::remove_dir_all(&removed).expect("fixture model should remove");
        assert!(!removed.exists());
        let _ignored = fs::remove_dir_all(root);
    }

    #[test]
    fn tc_mod_001_hash_failure_cleans_partial_install() {
        let root = test_root("hash");
        let served = b"tampered model".to_vec();
        let expected = b"approved model";
        let (url, server) = serve_once(served);
        let spec = local_spec(url, expected);
        let download_root = root.join("tmp").join("downloads");
        let error = install_spec(
            &spec,
            &root,
            &spec.entry.sha256,
            true,
            &download_root,
            &AtomicBool::new(false),
            |_| {},
        )
        .expect_err("hash mismatch must fail");
        server.join().expect("server should finish");
        assert_eq!(error.code, "MODEL_INTEGRITY_FAILED");
        assert!(!root.join("local-fixture").join("1.0.0").exists());
        assert_eq!(
            fs::read_dir(download_root)
                .expect("download root should exist")
                .count(),
            0
        );
        let _ignored = fs::remove_dir_all(root);
    }

    #[test]
    fn catalog_contains_only_the_two_user_approved_models() {
        let entries = model_catalog();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].model_id, "spleeter-2stems");
        assert_eq!(entries[1].model_id, "swiftf0");
    }

    fn shared_fixture(name: &str) -> Vec<u8> {
        fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("..")
                .join("fixtures")
                .join("contracts")
                .join("analyzer")
                .join(name),
        )
        .expect("shared fixture should read")
    }

    #[test]
    fn tc_con_001_validates_shared_model_catalog_and_manifest() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Catalog {
            schema_version: u32,
            models: Vec<ModelCatalogEntry>,
        }
        let catalog: Catalog =
            serde_json::from_slice(&shared_fixture("model-catalog-v1-current.json"))
                .expect("catalog fixture should parse");
        assert_eq!(catalog.schema_version, 1);
        assert_eq!(catalog.models.len(), 2);
        let manifest: InstalledModelManifest =
            serde_json::from_slice(&shared_fixture("model-manifest-v1-current.json"))
                .expect("manifest fixture should parse");
        assert_eq!(manifest.model_id, "swiftf0");
        assert_eq!(manifest.schema_version, 1);
    }

    #[test]
    fn tc_net_001_follows_only_bounded_allowlisted_redirects() {
        let bytes = b"redirected local model";
        let listener = TcpListener::bind("127.0.0.1:0").expect("redirect listener should bind");
        let address = listener.local_addr().expect("redirect address");
        let base = format!("http://{address}");
        let response_base = base.clone();
        let payload = bytes.to_vec();
        let handle = thread::spawn(move || {
            for index in 0..2 {
                let (mut stream, _) = listener.accept().expect("redirect request");
                let mut request = [0_u8; 2048];
                let _count = stream.read(&mut request).expect("request read");
                if index == 0 {
                    write!(
                        stream,
                        "HTTP/1.1 302 Found\r\nLocation: {response_base}/model.bin\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .expect("redirect write");
                } else {
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        payload.len()
                    )
                    .expect("headers write");
                    stream.write_all(&payload).expect("body write");
                }
            }
        });
        let root = test_root("redirect");
        fs::create_dir_all(&root).expect("root should exist");
        download_verified(
            &format!("{base}/redirect"),
            &["127.0.0.1".to_owned()],
            u64::try_from(bytes.len()).expect("size"),
            &hash(bytes),
            &root.join("model.bin"),
            true,
        )
        .expect("allowlisted redirect should pass");
        handle.join().expect("redirect server should finish");
        let _ignored = fs::remove_dir_all(root);
    }

    #[test]
    fn tc_net_001_rejects_oversize_interruption_and_preflight_cancel() {
        let root = test_root("network-errors");
        fs::create_dir_all(&root).expect("root should exist");
        let approved = b"approved";

        let (oversize_url, oversize_server) = serve_once(b"approved-extra".to_vec());
        let error = download_verified(
            &oversize_url,
            &["127.0.0.1".to_owned()],
            u64::try_from(approved.len()).expect("size"),
            &hash(approved),
            &root.join("oversize.bin"),
            true,
        )
        .expect_err("oversize response must fail");
        assert_eq!(error.code, "MODEL_INTEGRITY_FAILED");
        oversize_server
            .join()
            .expect("oversize server should finish");

        let partial = b"part";
        let response = [
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                approved.len()
            )
            .into_bytes(),
            partial.to_vec(),
        ]
        .concat();
        let (base, interrupted_server) = serve_responses(vec![response]);
        let error = download_verified(
            &format!("{base}/model.bin"),
            &["127.0.0.1".to_owned()],
            u64::try_from(approved.len()).expect("size"),
            &hash(approved),
            &root.join("partial.bin"),
            true,
        )
        .expect_err("interrupted response must fail");
        assert_eq!(error.code, "MODEL_DOWNLOAD_FAILED");
        interrupted_server
            .join()
            .expect("interrupted server should finish");

        let cancel = AtomicBool::new(true);
        let error = download_verified_controlled(
            "http://127.0.0.1:9/model.bin",
            &root.join("cancelled.bin"),
            DownloadExpectation {
                allowed_hosts: &["127.0.0.1".to_owned()],
                size_bytes: u64::try_from(approved.len()).expect("size"),
                expected_sha256: &hash(approved),
                allow_http: true,
            },
            &cancel,
            |_, _| {},
        )
        .expect_err("preflight cancellation must not connect");
        assert_eq!(error.code, "MODEL_DOWNLOAD_CANCELLED");
        assert!(!root.join("cancelled.bin").exists());
        let _ignored = fs::remove_dir_all(root);
    }

    #[test]
    fn tc_net_001_rejects_https_downgrade_and_disallowed_hosts() {
        let hosts = vec!["approved.example".to_owned()];
        let downgrade = validate_host("http://approved.example/model.bin", &hosts, false)
            .expect_err("production HTTPS must not downgrade");
        assert_eq!(downgrade.safe_details["reason"], "host_not_allowed");
        let host = validate_host("https://unapproved.example/model.bin", &hosts, false)
            .expect_err("unapproved host must fail");
        assert_eq!(host.safe_details["reason"], "host_not_allowed");
        let user_info = validate_host("https://user@approved.example/model.bin", &hosts, false)
            .expect_err("userinfo must fail");
        assert_eq!(user_info.safe_details["reason"], "host_not_allowed");
    }
}
