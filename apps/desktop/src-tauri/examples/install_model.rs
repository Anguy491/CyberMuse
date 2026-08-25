use std::path::PathBuf;

use cybermuse_desktop_lib::model_manager::install_model;

fn main() {
    let mut arguments = std::env::args_os().skip(1);
    let model_root = PathBuf::from(arguments.next().expect("model root argument is required"));
    let model_id = arguments
        .next()
        .and_then(|value| value.into_string().ok())
        .expect("model id argument is required");
    let version = arguments
        .next()
        .and_then(|value| value.into_string().ok())
        .expect("model version argument is required");
    let confirmed_sha256 = arguments
        .next()
        .and_then(|value| value.into_string().ok())
        .expect("confirmed SHA-256 argument is required");
    assert!(arguments.next().is_none(), "unexpected arguments");

    match install_model(&model_root, &model_id, &version, &confirmed_sha256) {
        Ok(installed) => println!(
            "installed modelId={} version={} sizeBytes={} sha256={} reused={}",
            installed.model_id,
            installed.version,
            installed.size_bytes,
            installed.sha256,
            installed.already_installed
        ),
        Err(error) => {
            eprintln!(
                "model install failed code={} diagnosticId={}",
                error.code, error.diagnostic_id
            );
            std::process::exit(1);
        }
    }
}
