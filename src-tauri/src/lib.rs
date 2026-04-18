pub mod agent_adapters;
pub mod application;
pub mod capability_services;
pub mod channel_api;
pub mod domain;
pub mod gateway;
pub mod runtime;
pub mod storage;

use std::sync::Arc;

use capability_services::system_path::{prime_process_path, write_path_diagnostics};
use channel_api::AppState;
use gateway::Gateway;
use tauri::Emitter;

pub fn bootstrap() -> Arc<Gateway> {
    prime_process_path();
    write_path_diagnostics(&[
        "gemini",
        "qwen",
        "opencode",
        "goose",
        "copilot",
        "qodercli",
        "agent",
        "kiro-cli",
    ]);
    let storage = storage::Database::open_default().expect("failed to open database");
    let gateway = Arc::new(Gateway::new(storage).expect("failed to initialize gateway"));
    gateway
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter("oneagent=debug")
        .init();
    let gateway = bootstrap();
    let managed_gateway = gateway.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            gateway: managed_gateway.clone(),
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let emitter = Arc::new(move |event: &str, payload: serde_json::Value| {
                let _ = handle.emit(event, payload);
            });
            managed_gateway.attach_emitter(emitter);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            channel_api::bootstrap_workspace,
            channel_api::list_agent_profiles,
            channel_api::list_agent_discovery_status,
            channel_api::refresh_agent_discovery,
            channel_api::upsert_agent_profile,
            channel_api::probe_agent_profile,
            channel_api::list_workspaces,
            channel_api::open_workspace,
            channel_api::get_or_create_default_workspace,
            channel_api::pick_workspace_directory,
            channel_api::list_workspace_files,
            channel_api::list_conversations,
            channel_api::search_conversations,
            channel_api::list_discovered_sessions,
            channel_api::create_conversation,
            channel_api::preview_session_config,
            channel_api::import_conversation,
            channel_api::create_task_run,
            channel_api::send_user_message,
            channel_api::cancel_turn,
            channel_api::delete_conversation,
            channel_api::set_session_config,
            channel_api::set_model,
            channel_api::set_mode,
            channel_api::persist_attachment_blob,
            channel_api::list_permissions,
            channel_api::resolve_permission_request,
            channel_api::list_workspace_mcp,
            channel_api::upsert_workspace_mcp,
            channel_api::list_workspace_skills,
            channel_api::get_conversation_timeline,
            channel_api::get_conversation_state,
            channel_api::list_task_runs
        ])
        .run(tauri::generate_context!())
        .expect("error while running OneAgent Tauri application");
}
