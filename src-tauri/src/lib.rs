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
use tauri::{Emitter, Manager};

/// Bootstrap error types for graceful error handling during startup.
#[derive(Debug)]
pub enum BootstrapError {
    Database(String),
    Gateway(String),
}

impl std::fmt::Display for BootstrapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BootstrapError::Database(msg) => write!(f, "Database initialization failed: {}", msg),
            BootstrapError::Gateway(msg) => write!(f, "Gateway initialization failed: {}", msg),
        }
    }
}

impl BootstrapError {
    /// Returns a user-friendly message for display in error dialogs.
    pub fn user_message(&self) -> String {
        match self {
            BootstrapError::Database(_) => {
                "OneAgent failed to initialize its database.\n\n\
                 This may be due to:\n\
                 - Insufficient disk space\n\
                 - Corrupted database file\n\
                 - Permission issues with the application data directory\n\n\
                 Please try restarting the application or check your system logs for details.".to_string()
            }
            BootstrapError::Gateway(_) => {
                "OneAgent failed to initialize its core services.\n\n\
                 Please try restarting the application or check your system logs for details.".to_string()
            }
        }
    }
}

pub fn bootstrap() -> Result<Arc<Gateway>, BootstrapError> {
    prime_process_path();
    write_path_diagnostics(&[
        "gemini", "qwen", "opencode", "goose", "copilot", "qodercli", "agent", "kiro-cli",
    ]);
    let storage = storage::Database::open_default()
        .map_err(|e| BootstrapError::Database(e.to_string()))?;
    let gateway = Gateway::new(storage)
        .map_err(|e| BootstrapError::Gateway(e.to_string()))?;
    Ok(Arc::new(gateway))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter("oneagent=debug,oneagent_lib::agent_adapters::acp::parser=info")
        .init();

    // Handle bootstrap errors gracefully
    let gateway = match bootstrap() {
        Ok(g) => g,
        Err(e) => {
            tracing::error!("Bootstrap failed: {}", e);
            // In Tauri, we cannot easily show a dialog before the app is fully initialized.
            // For now, log the error and exit. Users can check logs for details.
            // Future improvement: Use system-level dialog (e.g., native OS dialog)
            eprintln!("OneAgent startup failed: {}", e.user_message());
            return;
        }
    };

    let managed_gateway = gateway.clone();
    let terminal_manager = Arc::new(capability_services::terminal::TerminalManager::new());
    let im_manager = Arc::new(channel_api::im::ImChannelManager::new(gateway.clone()));
    let webui_manager = Arc::new(channel_api::web::manager::WebUiManager::new());
    let browser_manager = Arc::new(capability_services::browser::BrowserManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            gateway: managed_gateway.clone(),
            terminal_manager,
            im_manager: im_manager.clone(),
            webui_manager: webui_manager.clone(),
            browser_manager: browser_manager.clone(),
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let handle_for_emitter = handle.clone();
            let emitter: Arc<dyn Fn(&str, serde_json::Value) + Send + Sync> = Arc::new(move |event: &str, payload: serde_json::Value| {
                if let Err(e) = handle_for_emitter.emit(event, payload) {
                    tracing::warn!("Failed to emit event '{}' to frontend: {}", event, e);
                }
            });
            managed_gateway.attach_emitter(emitter.clone());

            // Inject browser MCP provider into runtime
            let bm_clone = browser_manager.clone();
            managed_gateway.runtime.set_browser_mcp_provider(move || {
                bm_clone.mcp_server_config()
            });

            // Attach event emitter to browser manager for screenshot events
            browser_manager.attach_emitter(emitter);

            // Register IM event sink to the event bus
            let im_event_sink = Arc::new(channel_api::im::ImChannelEventSink::new(im_manager.clone()));
            managed_gateway.runtime.event_bus.register(im_event_sink);

            // Initialize IM plugins asynchronously
            let im_manager_clone = im_manager.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = im_manager_clone.initialize_plugins().await {
                    tracing::error!("Failed to initialize IM plugins: {}", e);
                }
            });

            // Start axum web server if enabled in settings
            let gateway_clone = managed_gateway.clone();
            let terminal_manager_clone = app.state::<AppState>().terminal_manager.clone();
            let im_manager_web = im_manager.clone();
            let webui_manager_setup = webui_manager.clone();
            let handle_clone = handle.clone();
            
            tauri::async_runtime::spawn(async move {
                let enabled_str = gateway_clone.db.get_system_setting("enable_webui")
                    .unwrap_or(None)
                    .unwrap_or_else(|| "false".to_string());

                if enabled_str == "true" {
                    let port = std::env::var("ONEAGENT_WEB_PORT")
                        .ok()
                        .and_then(|p| p.parse::<u16>().ok())
                        .unwrap_or(19520);
                    webui_manager_setup.start(
                         gateway_clone,
                         terminal_manager_clone,
                         im_manager_web,
                         Some(handle_clone),
                         port,
                         true,
                    ).await;
                }
            });

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
            channel_api::archive_workspace,
            channel_api::get_or_create_default_workspace,
            channel_api::pick_workspace_directory,
            channel_api::list_workspace_files,
            channel_api::git_diff,
            channel_api::read_file_content,
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
            channel_api::delete_workspace_mcp,
            channel_api::test_mcp_connection,
            channel_api::import_mcp_configs,
            channel_api::list_workspace_skills,
            channel_api::get_conversation_timeline,
            channel_api::get_conversation_state,
            channel_api::list_task_runs,
            channel_api::spawn_terminal,
            channel_api::write_to_terminal,
            channel_api::resize_terminal,
            channel_api::close_terminal,
            channel_api::im::list_im_plugins,
            channel_api::im::start_im_plugin,
            channel_api::im::stop_im_plugin,
            channel_api::im::approve_im_pairing,
            channel_api::im::start_weixin_login,
            channel_api::im::stop_weixin_login,
            channel_api::im::update_im_plugin_config,
            channel_api::get_webui_enabled,
            channel_api::set_webui_enabled,
            channel_api::get_webui_password,
            channel_api::get_webui_info,
            channel_api::start_browser_session,
            channel_api::stop_browser_session,
            channel_api::get_browser_status,
            channel_api::get_browser_config,
            channel_api::save_browser_config,
            channel_api::get_browser_mcp_config,
            channel_api::navigate_browser,
            channel_api::browser_click,
            channel_api::browser_fill,
            channel_api::browser_scroll,
            channel_api::browser_reload,
            channel_api::browser_go_back,
            channel_api::browser_go_forward,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OneAgent Tauri application");
}
