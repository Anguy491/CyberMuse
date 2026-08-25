use tauri::Manager;

pub mod analysis_coordinator;
pub mod analysis_store;
pub mod analyzer_process;
pub mod analyzer_protocol;
pub mod analyzer_request;
pub mod model_manager;
pub mod runtime_manifest;
pub mod storage;
pub mod tauri_api;
pub mod tool_manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .setup(|app| {
            let state = tauri_api::initialize(&app.handle().clone()).map_err(|error| {
                Box::<dyn std::error::Error>::from(std::io::Error::other(error))
            })?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tauri_api::start_analysis,
            tauri_api::cancel_analysis,
            tauri_api::get_analysis_job,
            tauri_api::get_model_status,
            tauri_api::install_model,
            tauri_api::cancel_model_install,
            tauri_api::remove_model,
        ]);
    if let Err(error) = builder.run(tauri::generate_context!()) {
        eprintln!("CyberMuse desktop startup failed: {error}");
        std::process::exit(1);
    }
}
