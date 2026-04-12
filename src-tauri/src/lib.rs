pub mod agent_adapters;
pub mod capability_services;
pub mod channel_api;
pub mod domain;
pub mod gateway;
pub mod runtime;
pub mod storage;

use std::sync::Arc;

use channel_api::AppState;
use gateway::Gateway;
use tauri::Emitter;

pub fn bootstrap() -> Arc<Gateway> {
    let storage = storage::Database::open_default().expect("failed to open database");
    let gateway = Arc::new(Gateway::new(storage).expect("failed to initialize gateway"));
    gateway
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let gateway = bootstrap();
    let managed_gateway = gateway.clone();
    tauri::Builder::default()
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
            channel_api::list_conversations,
            channel_api::list_discovered_sessions,
            channel_api::create_conversation,
            channel_api::import_conversation,
            channel_api::create_task_run,
            channel_api::send_user_message,
            channel_api::cancel_turn,
            channel_api::delete_conversation,
            channel_api::set_session_config,
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
