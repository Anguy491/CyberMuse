use std::path::PathBuf;

use cybermuse_desktop_lib::analysis_store::validate_analysis;
use cybermuse_desktop_lib::analyzer_request::{read_and_validate_request, validation_expectation};

fn main() {
    let request_path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .expect("usage: validate_analysis <request.json>");
    let request = read_and_validate_request(&request_path).expect("request must validate");
    let expected = validation_expectation(&request).expect("expectation must build");
    let validated =
        validate_analysis(&request.staging_path, &expected).expect("analysis must validate");
    println!(
        "validated analysis {} with {} artifacts",
        validated.manifest.analysis_id,
        validated.manifest.artifacts.len()
    );
}
