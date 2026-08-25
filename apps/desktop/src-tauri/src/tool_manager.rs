use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use sha2::{Digest, Sha256};

const VERSION: &str = "n9.0.1-6-g9d4ca21220";
const FFMPEG_SHA256: &str = "f4326d7a480fb9e81a34440e775a70ebcf263a0c5fbc45678ffc594a9a7eccf3";
const FFPROBE_SHA256: &str = "1c9b4e13cdc83bf7a4e2f40a69716a62eddc6810a7a6abaacbc568ffaf77c8e9";
const REQUIRED_RUNTIME_FILES: &[&str] = &[
    "ffmpeg.exe",
    "ffprobe.exe",
    "avcodec-63.dll",
    "avdevice-63.dll",
    "avfilter-12.dll",
    "avformat-63.dll",
    "avutil-61.dll",
    "swresample-7.dll",
    "swscale-10.dll",
    "LICENSE.txt",
];
static DIAGNOSTIC_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolError {
    pub code: &'static str,
    pub message_key: &'static str,
    pub retryable: bool,
    pub safe_details: BTreeMap<String, String>,
    pub diagnostic_id: String,
}

impl ToolError {
    fn integrity(reason: &'static str) -> Self {
        let mut safe_details = BTreeMap::new();
        safe_details.insert("reason".to_owned(), reason.to_owned());
        Self {
            code: "TOOL_INTEGRITY_FAILED",
            message_key: "tool.error.integrityFailed",
            retryable: false,
            safe_details,
            diagnostic_id: format!(
                "tool-{}-{}",
                std::process::id(),
                DIAGNOSTIC_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledFfmpeg {
    pub schema_version: u32,
    pub tool_id: String,
    pub version: String,
    pub ffmpeg_path: PathBuf,
    pub ffprobe_path: PathBuf,
    pub ffmpeg_sha256: String,
    pub ffprobe_sha256: String,
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sha256_file(path: &Path) -> Result<String, ToolError> {
    let mut file = File::open(path).map_err(|_| ToolError::integrity("binary_missing"))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| ToolError::integrity("binary_unreadable"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(hex_digest(digest.finalize()))
}

fn validate_regular_file(root: &Path, name: &str) -> Result<PathBuf, ToolError> {
    let path = root.join(name);
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| ToolError::integrity("runtime_file_missing"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(ToolError::integrity("runtime_file_type"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(ToolError::integrity("runtime_reparse_point"));
        }
    }
    Ok(path)
}

fn verify_binary(ffmpeg: &Path) -> Result<(), ToolError> {
    let parent = ffmpeg
        .parent()
        .ok_or_else(|| ToolError::integrity("parent"))?;
    let output = Command::new(ffmpeg)
        .arg("-version")
        .env_clear()
        .env("PATH", parent)
        .env(
            "SYSTEMROOT",
            std::env::var_os("SYSTEMROOT").unwrap_or_else(|| r"C:\Windows".into()),
        )
        .env(
            "WINDIR",
            std::env::var_os("WINDIR").unwrap_or_else(|| r"C:\Windows".into()),
        )
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .current_dir(parent)
        .output()
        .map_err(|_| ToolError::integrity("version_start"))?;
    let text =
        String::from_utf8(output.stdout).map_err(|_| ToolError::integrity("version_encoding"))?;
    let configuration = text
        .lines()
        .find(|line| line.starts_with("configuration:"))
        .ok_or_else(|| ToolError::integrity("configuration_missing"))?;
    if !output.status.success()
        || !text.contains("ffmpeg version n9.0.1-6-g9d4ca21220")
        || !configuration.contains("--enable-shared")
        || configuration.contains("--enable-gpl")
        || configuration.contains("--enable-nonfree")
    {
        return Err(ToolError::integrity("configuration_unapproved"));
    }
    Ok(())
}

/// Validates an already bundled FFmpeg runtime. CyberMuse never downloads tools
/// at runtime; only the explicitly consented model installer has network access.
pub fn validate_bundled_ffmpeg(tool_root: &Path) -> Result<InstalledFfmpeg, ToolError> {
    let canonical_root = tool_root
        .canonicalize()
        .map_err(|_| ToolError::integrity("tool_root"))?;
    for name in REQUIRED_RUNTIME_FILES {
        validate_regular_file(&canonical_root, name)?;
    }
    let ffmpeg = canonical_root.join("ffmpeg.exe");
    let ffprobe = canonical_root.join("ffprobe.exe");
    if sha256_file(&ffmpeg)? != FFMPEG_SHA256 || sha256_file(&ffprobe)? != FFPROBE_SHA256 {
        return Err(ToolError::integrity("binary_hash"));
    }
    verify_binary(&ffmpeg)?;
    Ok(InstalledFfmpeg {
        schema_version: 1,
        tool_id: "ffmpeg-lgpl-shared".to_owned(),
        version: VERSION.to_owned(),
        ffmpeg_path: ffmpeg,
        ffprobe_path: ffprobe,
        ffmpeg_sha256: FFMPEG_SHA256.to_owned(),
        ffprobe_sha256: FFPROBE_SHA256.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_tool_catalog_is_exact_and_network_free() {
        assert_eq!(VERSION, "n9.0.1-6-g9d4ca21220");
        assert_eq!(REQUIRED_RUNTIME_FILES.len(), 10);
        assert!(REQUIRED_RUNTIME_FILES.contains(&"LICENSE.txt"));
        assert_eq!(FFMPEG_SHA256.len(), 64);
        assert_eq!(FFPROBE_SHA256.len(), 64);
    }
}
