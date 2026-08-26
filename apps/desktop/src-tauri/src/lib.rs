use tauri::Manager;

pub mod analysis_coordinator;
pub mod analysis_store;
pub mod analyzer_process;
pub mod analyzer_protocol;
pub mod analyzer_request;
pub mod asset_protocol;
pub mod diagnostics;
pub mod model_manager;
pub mod runtime_manifest;
pub mod session_store;
pub mod settings_store;
pub mod song_store;
pub mod storage;
pub mod tauri_api;
pub mod tool_manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let resources = asset_protocol::ResourceRegistry::new();
    let protocol_resources = resources.clone();
    let state_resources = resources.clone();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("cybermuse", move |_context, request| {
            protocol_resources.handle(request)
        })
        .setup(move |app| {
            let state = tauri_api::initialize(&app.handle().clone(), state_resources.clone())
                .map_err(|error| {
                    Box::<dyn std::error::Error>::from(std::io::Error::other(error))
                })?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tauri_api::select_import_file,
            tauri_api::confirm_import,
            tauri_api::list_songs,
            tauri_api::get_song,
            tauri_api::prepare_delete_song,
            tauri_api::delete_song,
            tauri_api::get_practice_assets,
            tauri_api::save_practice_session,
            tauri_api::list_practice_sessions,
            tauri_api::get_practice_session,
            tauri_api::delete_practice_session,
            tauri_api::get_app_settings,
            tauri_api::update_app_settings,
            tauri_api::clear_app_settings,
            tauri_api::prepare_diagnostic_bundle,
            tauri_api::save_diagnostic_bundle,
            tauri_api::clear_diagnostic_logs,
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
