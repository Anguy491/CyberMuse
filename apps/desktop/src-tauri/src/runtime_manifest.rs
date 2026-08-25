use std::collections::BTreeSet;

use serde::Deserialize;

const EMBEDDED_RUNTIME_MANIFEST: &str =
    include_str!("../../../../artifacts/m4/tauri-resources/runtime-manifest.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    schema_version: u32,
    files: Vec<RuntimeFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeFile {
    relative_path: String,
    sha256: String,
}

/// Returns the build-time trust anchor for a bundled runtime file. The analyzer
/// resources are built before Cargo, so `include_str!` makes any inventory
/// change invalidate and rebuild the desktop crate.
pub fn bundled_sha256(relative_path: &str) -> Option<String> {
    let manifest: RuntimeManifest = serde_json::from_str(EMBEDDED_RUNTIME_MANIFEST).ok()?;
    if manifest.schema_version != 1 {
        return None;
    }
    let mut seen = BTreeSet::new();
    let mut matched = None;
    for file in manifest.files {
        if !seen.insert(file.relative_path.clone())
            || file.sha256.len() != 64
            || !file
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return None;
        }
        if file.relative_path == relative_path {
            matched = Some(file.sha256);
        }
    }
    matched
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_manifest_has_unique_pinned_sidecars() {
        assert!(bundled_sha256("analyzer/cybermuse-analyzer.exe").is_some());
        assert!(bundled_sha256("spleeter-engine/cybermuse-spleeter-engine.exe").is_some());
        assert!(bundled_sha256("missing.exe").is_none());
    }
}
