use std::{fs, sync::Arc};

use chrono::{DateTime, Utc};

use serde::Deserialize;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

pub mod web;
pub mod im;

pub use im::{list_im_plugins, start_im_plugin, stop_im_plugin, approve_im_pairing, start_weixin_login, stop_weixin_login, update_im_plugin_config};

use crate::{
    domain::{BackendError, FileContentResult, *},
    gateway::Gateway,
};

#[derive(Clone)]
pub struct AppState {
    pub gateway: Arc<Gateway>,
    pub terminal_manager: Arc<crate::capability_services::terminal::TerminalManager>,
    pub im_manager: Arc<im::ImChannelManager>,
    pub webui_manager: Arc<web::manager::WebUiManager>,
    pub browser_manager: Arc<crate::capability_services::browser::BrowserManager>,
}

#[derive(Debug, Deserialize)]
pub struct ImportConversationInput {
    pub workspace_id: String,
    pub agent_profile_id: String,
    pub remote_session_id: String,
}

#[derive(Debug, Deserialize)]
pub struct SendUserMessageInput {
    pub conversation_id: String,
    pub text: String,
    pub attachments: Option<Vec<AttachmentInput>>,
}

#[derive(Debug, Deserialize)]
pub struct ResolvePermissionInput {
    pub conversation_id: String,
    pub tool_call_id: String,
    pub fingerprint: String,
    pub decision: PermissionDecisionKind,
}

#[tauri::command]
pub async fn bootstrap_workspace(
    state: State<'_, AppState>,
    input: WorkspaceBootstrapInput,
) -> Result<WorkspaceBootstrap, BackendError> {
    state
        .gateway
        .bootstrap_workspace(input)
        .await
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn list_agent_profiles(
    state: State<'_, AppState>,
) -> Result<Vec<AgentProfile>, BackendError> {
    state
        .gateway
        .list_agent_profiles()
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn list_agent_discovery_status(
    state: State<'_, AppState>,
) -> Result<Vec<AgentDiscoveryStatus>, BackendError> {
    state
        .gateway
        .list_agent_discovery_status()
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn refresh_agent_discovery(
    state: State<'_, AppState>,
) -> Result<Vec<AgentProfile>, BackendError> {
    state
        .gateway
        .refresh_agent_discovery()
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn upsert_agent_profile(
    state: State<'_, AppState>,
    input: UpsertAgentProfileInput,
) -> Result<AgentProfile, BackendError> {
    state
        .gateway
        .upsert_agent_profile(input)
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn probe_agent_profile(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<AgentCapabilities, BackendError> {
    state
        .gateway
        .probe_agent_profile(&profile_id)
        .await
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn list_workspaces(state: State<'_, AppState>) -> Result<Vec<Workspace>, BackendError> {
    state.gateway.list_workspaces().map_err(BackendError::from)
}

#[tauri::command]
pub async fn open_workspace(
    state: State<'_, AppState>,
    cwd: String,
) -> Result<Workspace, BackendError> {
    state
        .gateway
        .open_workspace(&cwd)
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn archive_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<(), BackendError> {
    state
        .gateway
        .archive_workspace(&workspace_id)
        .map_err(BackendError::from)
}

/// Get or create the default workspace at ~/.oneagent/workspace/
#[tauri::command]
pub async fn get_or_create_default_workspace(
    state: State<'_, AppState>,
) -> Result<Workspace, BackendError> {
    // Get the home directory
    let home_dir = dirs::home_dir().ok_or_else(|| {
        BackendError::new(
            ErrorCode::InvalidWorkspacePath,
            "Could not determine home directory",
        )
    })?;

    // Create ~/.oneagent/workspace directory
    let oneagent_root = home_dir.join(".oneagent");
    let default_workspace_dir = oneagent_root.join("workspace");

    // Ensure ~/.oneagent root exists (for skills directory)
    if !oneagent_root.exists() {
        std::fs::create_dir_all(&oneagent_root).map_err(|e| {
            BackendError::new(
                ErrorCode::InvalidWorkspacePath,
                format!("Failed to create oneagent root directory: {e}"),
            )
        })?;
    }

    // Create workspace subdirectory
    if !default_workspace_dir.exists() {
        std::fs::create_dir_all(&default_workspace_dir).map_err(|e| {
            BackendError::new(
                ErrorCode::InvalidWorkspacePath,
                format!("Failed to create default workspace directory: {e}"),
            )
        })?;
    }

    // Open the workspace
    let cwd = default_workspace_dir.to_string_lossy().to_string();
    state
        .gateway
        .open_workspace(&cwd)
        .map_err(BackendError::from)
}

/// Pick a workspace directory using the system file dialog
#[tauri::command]
pub async fn pick_workspace_directory(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<Workspace>, BackendError> {
    // Use Tauri's dialog plugin to pick a directory
    let folder_path = app.dialog().file().blocking_pick_folder();

    match folder_path {
        Some(path) => {
            let cwd = path.to_string();
            let workspace = state
                .gateway
                .open_workspace(&cwd)
                .map_err(BackendError::from)?;
            Ok(Some(workspace))
        }
        None => Ok(None), // User cancelled the dialog
    }
}

#[tauri::command]
pub async fn list_workspace_files(
    cwd: String,
    directory_path: Option<String>,
) -> Result<Vec<WorkspaceFileEntry>, BackendError> {
    let workspace_path = std::path::PathBuf::from(&cwd);
    if !workspace_path.exists() {
        return Err(BackendError::new(
            ErrorCode::InvalidWorkspacePath,
            format!("Workspace path does not exist: {cwd}"),
        ));
    }
    if !workspace_path.is_dir() {
        return Err(BackendError::new(
            ErrorCode::InvalidWorkspacePath,
            format!("Workspace path is not a directory: {cwd}"),
        ));
    }

    let workspace_root = workspace_path.canonicalize().map_err(|error| {
        BackendError::new(
            ErrorCode::InvalidWorkspacePath,
            format!("Failed to resolve workspace root: {error}"),
        )
    })?;

    let target_path = match directory_path {
        Some(path) => std::path::PathBuf::from(path),
        None => workspace_root.clone(),
    };

    let target_path = target_path.canonicalize().map_err(|error| {
        BackendError::new(
            ErrorCode::InvalidInput,
            format!("Failed to resolve target directory: {error}"),
        )
    })?;

    if !target_path.starts_with(&workspace_root) {
        return Err(BackendError::new(
            ErrorCode::InvalidInput,
            "Directory is outside workspace root",
        ));
    }

    if !target_path.is_dir() {
        return Err(BackendError::new(
            ErrorCode::InvalidInput,
            "Target path is not a directory",
        ));
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(&target_path).map_err(|error| {
        BackendError::new(
            ErrorCode::InvalidInput,
            format!("Failed to read workspace files: {error}"),
        )
    })?;

    for dir_entry in read_dir {
        let dir_entry = match dir_entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = dir_entry.path();
        let metadata = match dir_entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let modified_at = metadata.modified().ok().map(DateTime::<Utc>::from);

        entries.push(WorkspaceFileEntry {
            name: dir_entry.file_name().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            size_bytes: metadata.is_file().then_some(metadata.len()),
            modified_at,
        });
    }

    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub async fn git_diff(cwd: String) -> Result<GitDiffResult, BackendError> {
    let workspace_path = std::path::PathBuf::from(&cwd);
    if !workspace_path.exists() {
        return Err(BackendError::new(
            ErrorCode::InvalidWorkspacePath,
            format!("Workspace path does not exist: {cwd}"),
        ));
    }
    if !workspace_path.is_dir() {
        return Err(BackendError::new(
            ErrorCode::InvalidWorkspacePath,
            format!("Workspace path is not a directory: {cwd}"),
        ));
    }

    // Helper to run git commands and capture stdout
    async fn git_output_raw(cwd: &str, args: &[&str]) -> Result<std::process::Output, BackendError> {
        let mut cmd = tokio::process::Command::new("git");
        cmd.args(args).current_dir(cwd);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd.output().await.map_err(|e| {
            BackendError::new(
                ErrorCode::RuntimeError,
                format!("Failed to run git: {e}"),
            )
        })
    }

    // Pre-flight check: verify this is a git repository
    let check_output = git_output_raw(&cwd, &["rev-parse", "--git-dir"]).await?;
    if !check_output.status.success() {
        let stderr = String::from_utf8_lossy(&check_output.stderr);
        if stderr.contains("not a git repository") {
            return Err(BackendError::new(
                ErrorCode::NotAGitRepository,
                "Not a Git repository",
            ));
        }
        // Other git errors
        return Err(BackendError::new(
            ErrorCode::RuntimeError,
            stderr.to_string(),
        ));
    }

    // Helper for diff commands (exit code 0 or 1 is success)
    async fn git_output(cwd: &str, args: &[&str]) -> Result<String, BackendError> {
        let o = git_output_raw(cwd, args).await?;
        if o.status.success() || o.status.code() == Some(1) {
            // git diff exits 1 when there are differences
            Ok(String::from_utf8_lossy(&o.stdout).to_string())
        } else {
            Err(BackendError::new(
                ErrorCode::RuntimeError,
                String::from_utf8_lossy(&o.stderr).to_string(),
            ))
        }
    }

    let (unstaged, staged) = tokio::try_join!(
        git_output(&cwd, &["diff"]),
        git_output(&cwd, &["diff", "--cached"])
    )?;

    Ok(GitDiffResult { unstaged, staged })
}

/// Read file content for preview
/// Safety: ensures the file is within workspace root and limits file size to 1MB
#[tauri::command]
pub async fn read_file_content(
    cwd: String,
    file_path: String,
) -> Result<FileContentResult, BackendError> {
    let workspace_path = std::path::PathBuf::from(&cwd);
    if !workspace_path.exists() {
        return Err(BackendError::new(
            ErrorCode::InvalidWorkspacePath,
            format!("Workspace path does not exist: {cwd}"),
        ));
    }

    let workspace_root = workspace_path.canonicalize().map_err(|error| {
        BackendError::new(
            ErrorCode::InvalidWorkspacePath,
            format!("Failed to resolve workspace root: {error}"),
        )
    })?;

    let target_path = std::path::PathBuf::from(&file_path);
    if !target_path.exists() {
        return Err(BackendError::new(
            ErrorCode::InvalidInput,
            format!("File does not exist: {file_path}"),
        ));
    }

    let canonical_target = target_path.canonicalize().map_err(|error| {
        BackendError::new(
            ErrorCode::InvalidInput,
            format!("Failed to resolve file path: {error}"),
        )
    })?;

    // Security check: ensure file is within workspace root
    if !canonical_target.starts_with(&workspace_root) {
        return Err(BackendError::new(
            ErrorCode::InvalidInput,
            "File is outside workspace root",
        ));
    }

    // Check if it's a file (not a directory)
    if !canonical_target.is_file() {
        return Err(BackendError::new(
            ErrorCode::InvalidInput,
            "Path is not a file",
        ));
    }

    // Check file size limit (1MB)
    let metadata = fs::metadata(&canonical_target).map_err(|error| {
        BackendError::new(
            ErrorCode::RuntimeError,
            format!("Failed to read file metadata: {error}"),
        )
    })?;

    const MAX_FILE_SIZE: u64 = 1_048_576; // 1MB
    if metadata.len() > MAX_FILE_SIZE {
        return Err(BackendError::new(
            ErrorCode::InvalidInput,
            format!("File too large: {} bytes (max {} bytes)", metadata.len(), MAX_FILE_SIZE),
        ));
    }

    // Read file content
    let content = fs::read_to_string(&canonical_target).map_err(|error| {
        BackendError::new(
            ErrorCode::RuntimeError,
            format!("Failed to read file content: {error}"),
        )
    })?;

    Ok(FileContentResult {
        content,
        size_bytes: metadata.len(),
    })
}

#[tauri::command]
pub async fn list_conversations(
    state: State<'_, AppState>,
    workspace_id: String,
    filter: ConversationFilter,
) -> Result<Vec<Conversation>, BackendError> {
    state
        .gateway
        .list_conversations(&workspace_id, filter)
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn search_conversations(
    state: State<'_, AppState>,
    input: SearchConversationsInput,
) -> Result<Vec<Conversation>, BackendError> {
    state
        .gateway
        .search_conversations(input)
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn list_discovered_sessions(
    state: State<'_, AppState>,
    workspace_id: String,
    agent_profile_id: String,
    scope: String,
) -> Result<Vec<ExternalSession>, BackendError> {
    state
        .gateway
        .list_discovered_sessions(&workspace_id, &agent_profile_id, &scope)
        .await
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn create_conversation(
    state: State<'_, AppState>,
    input: CreateConversationInput,
) -> Result<ConversationState, BackendError> {
    // Auto-start browser if configured and enabled
    let browser_config_key = format!("browser_config_{}", input.workspace_id);
    if let Ok(Some(json_str)) = state.gateway.db.get_system_setting(&browser_config_key) {
        if let Ok(config) = serde_json::from_str::<BrowserSessionConfig>(&json_str) {
            if config.enabled && state.browser_manager.status().state != BrowserState::Running {
                if let Err(e) = state.browser_manager.start(config).await {
                    tracing::warn!("Auto-start browser failed: {e}");
                }
                // Brief wait for browser to initialize
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
            }
        }
    }

    state
        .gateway
        .create_conversation(input)
        .await
        .map_err(|e| {
            tracing::error!("create_conversation failed: {e}");
            BackendError::from(e)
        })
}

#[tauri::command]
pub async fn preview_session_config(
    state: State<'_, AppState>,
    input: PreviewSessionConfigInput,
) -> Result<PreviewSessionConfigResult, BackendError> {
    state
        .gateway
        .preview_session_config(input)
        .await
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn import_conversation(
    state: State<'_, AppState>,
    input: ImportConversationInput,
) -> Result<ConversationState, BackendError> {
    state
        .gateway
        .import_conversation(
            &input.workspace_id,
            &input.agent_profile_id,
            &input.remote_session_id,
        )
        .await
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn create_task_run(
    state: State<'_, AppState>,
    input: CreateTaskRunInput,
) -> Result<ConversationState, BackendError> {
    state
        .gateway
        .create_task_run(input)
        .await
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn send_user_message(
    state: State<'_, AppState>,
    input: SendUserMessageInput,
) -> Result<TimelineResponse, BackendError> {
    state
        .gateway
        .send_user_message(
            &input.conversation_id,
            &input.text,
            input.attachments.unwrap_or_default(),
        )
        .await
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn cancel_turn(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), BackendError> {
    state
        .gateway
        .cancel_turn(&conversation_id)
        .await
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn delete_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), BackendError> {
    state
        .gateway
        .delete_conversation(&conversation_id)
        .await
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn set_session_config(
    state: State<'_, AppState>,
    input: SessionConfigInput,
) -> Result<Vec<SessionConfigOption>, BackendError> {
    state
        .gateway
        .set_session_config(input)
        .await
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn set_model(
    state: State<'_, AppState>,
    input: SetModelInput,
) -> Result<AcpSessionModels, BackendError> {
    state
        .gateway
        .set_model(input)
        .await
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn set_mode(
    state: State<'_, AppState>,
    input: crate::domain::SetModeInput,
) -> Result<crate::domain::AcpSessionModeState, BackendError> {
    state
        .gateway
        .set_mode(input)
        .await
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn persist_attachment_blob(
    state: State<'_, AppState>,
    input: PersistAttachmentBlobInput,
) -> Result<PersistAttachmentBlobOutput, BackendError> {
    state
        .gateway
        .persist_attachment_blob(input)
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn list_permissions(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<PermissionDecision>, BackendError> {
    state
        .gateway
        .list_permissions(&conversation_id)
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn resolve_permission_request(
    state: State<'_, AppState>,
    input: ResolvePermissionInput,
) -> Result<PermissionDecision, BackendError> {
    state
        .gateway
        .resolve_permission_request(
            &input.conversation_id,
            &input.tool_call_id,
            &input.fingerprint,
            input.decision,
        )
        .await
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn list_workspace_mcp(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<McpServerConfig>, BackendError> {
    state
        .gateway
        .list_workspace_mcp(&workspace_id)
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn upsert_workspace_mcp(
    state: State<'_, AppState>,
    config: McpServerConfig,
) -> Result<McpServerConfig, BackendError> {
    state
        .gateway
        .upsert_workspace_mcp(config)
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn delete_workspace_mcp(
    state: State<'_, AppState>,
    config_id: String,
) -> Result<(), BackendError> {
    state
        .gateway
        .delete_workspace_mcp(&config_id)
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn test_mcp_connection(
    state: State<'_, AppState>,
    config: McpServerConfig,
) -> Result<McpServerStatus, BackendError> {
    state
        .gateway
        .test_mcp_connection(config)
        .await
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn import_mcp_configs(
    state: State<'_, AppState>,
    workspace_id: String,
    json_string: String,
) -> Result<Vec<McpServerConfig>, BackendError> {
    state
        .gateway
        .import_mcp_configs(&workspace_id, &json_string)
        .await
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn list_workspace_skills(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<SkillRecord>, BackendError> {
    state
        .gateway
        .list_workspace_skills(&workspace_id)
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn get_conversation_timeline(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<TimelineResponse, BackendError> {
    state
        .gateway
        .get_conversation_timeline(&conversation_id)
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn get_conversation_state(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<ConversationState, BackendError> {
    state
        .gateway
        .get_conversation_state(&conversation_id)
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn list_task_runs(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<TaskRun>, BackendError> {
    state
        .gateway
        .list_task_runs(&workspace_id)
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn spawn_terminal(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    cwd: Option<String>,
) -> Result<(), BackendError> {
    state
        .terminal_manager
        .spawn_session(id, cwd, app)
        .await
        .map_err(|e| BackendError::new(ErrorCode::RuntimeError, e))
}

#[tauri::command]
pub async fn write_to_terminal(
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), BackendError> {
    state
        .terminal_manager
        .write(&id, &data)
        .await
        .map_err(|e| BackendError::new(ErrorCode::RuntimeError, e))
}

#[tauri::command]
pub async fn resize_terminal(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), BackendError> {
    state
        .terminal_manager
        .resize(&id, cols, rows)
        .await
        .map_err(|e| BackendError::new(ErrorCode::RuntimeError, e))
}

#[tauri::command]
pub async fn close_terminal(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), BackendError> {
    state
        .terminal_manager
        .close(&id)
        .await
        .map_err(|e| BackendError::new(ErrorCode::RuntimeError, e))
}

#[tauri::command]
pub async fn get_webui_enabled(
    state: State<'_, AppState>,
) -> Result<bool, BackendError> {
    let enabled_str = state
        .gateway
        .db
        .get_system_setting("enable_webui")
        .map_err(crate::gateway::GatewayError::from)
        .map_err(BackendError::from)?
        .unwrap_or_else(|| "false".to_string());
    Ok(enabled_str == "true")
}

#[tauri::command]
pub async fn set_webui_enabled(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    enabled: bool,
) -> Result<Option<String>, BackendError> {
    state
        .gateway
        .db
        .set_system_setting("enable_webui", &enabled.to_string())
        .map_err(crate::gateway::GatewayError::from)
        .map_err(BackendError::from)?;

    let mut generated_password = None;

    if enabled {
        // Pre-generate auth config (including jwt_secret) before starting server,
        // so both the server and token creation read the same secret.
        let home_dir = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
        let config_path = home_dir.join(".oneagent").join("web_auth.json");
        generated_password = web::auth::AuthService::ensure_initialized_at(&config_path);
        // Force migration of jwt_secret into the config file
        let _ = web::auth::AuthService::new();

        let port = std::env::var("ONEAGENT_WEB_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(19520);

        state.webui_manager.start(
            state.gateway.clone(),
            state.terminal_manager.clone(),
            state.im_manager.clone(),
            Some(app_handle),
            port,
            true,
        ).await;
    } else {
        state.webui_manager.stop().await;
    }

    Ok(generated_password)
}

#[tauri::command]
pub async fn get_webui_password() -> Result<Option<String>, BackendError> {
    let home_dir = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let config_path = home_dir.join(".oneagent").join("web_auth.json");
    Ok(web::auth::AuthService::get_password_at(&config_path))
}

#[tauri::command]
pub async fn get_webui_info(
    state: State<'_, AppState>,
) -> Result<Option<WebUiInfo>, BackendError> {
    if !state.webui_manager.is_running().await {
        return Ok(None);
    }

    let port: u16 = std::env::var("ONEAGENT_WEB_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(19520);

    // Generate a JWT for auto-login URLs
    let home_dir = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let config_path = home_dir.join(".oneagent").join("web_auth.json");
    let token = web::auth::AuthService::create_token(&config_path)
        .unwrap_or_default();

    let mut urls = vec![format!("http://127.0.0.1:{}/?token={}", port, token)];

    // Detect LAN IP via UDP socket trick
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(local_addr) = socket.local_addr() {
                let ip = local_addr.ip();
                if !ip.is_loopback() {
                    urls.push(format!("http://{}:{}/?token={}", ip, port, token));
                }
            }
        }
    }

    Ok(Some(WebUiInfo { port, urls }))
}

#[derive(serde::Serialize)]
pub struct WebUiInfo {
    pub port: u16,
    pub urls: Vec<String>,
}

// Browser Use Commands

#[tauri::command]
pub async fn start_browser_session(
    state: State<'_, AppState>,
    config: BrowserSessionConfig,
) -> Result<BrowserSessionStatus, BackendError> {
    state
        .browser_manager
        .start(config)
        .await
        .map_err(|e| BackendError::new(ErrorCode::RuntimeError, e))?;
    Ok(state.browser_manager.status())
}

#[tauri::command]
pub async fn stop_browser_session(
    state: State<'_, AppState>,
) -> Result<(), BackendError> {
    state
        .browser_manager
        .stop()
        .await
        .map_err(|e| BackendError::new(ErrorCode::RuntimeError, e))
}

#[tauri::command]
pub async fn get_browser_status(
    state: State<'_, AppState>,
) -> Result<BrowserSessionStatus, BackendError> {
    Ok(state.browser_manager.status())
}

#[tauri::command]
pub async fn get_browser_config(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<BrowserSessionConfig, BackendError> {
    let key = format!("browser_config_{}", workspace_id);
    match state.gateway.db.get_system_setting(&key) {
        Ok(Some(json_str)) => {
            serde_json::from_str(&json_str)
                .map_err(|e| BackendError::new(ErrorCode::StorageError, e.to_string()))
        }
        _ => Ok(BrowserSessionConfig::default()),
    }
}

#[tauri::command]
pub async fn save_browser_config(
    state: State<'_, AppState>,
    workspace_id: String,
    config: BrowserSessionConfig,
) -> Result<(), BackendError> {
    let key = format!("browser_config_{}", workspace_id);
    let json_str = serde_json::to_string(&config)
        .map_err(|e| BackendError::new(ErrorCode::StorageError, e.to_string()))?;
    state.gateway.db.set_system_setting(&key, &json_str)
        .map_err(|e| BackendError::new(ErrorCode::StorageError, e.to_string()))
}

#[tauri::command]
pub async fn get_browser_mcp_config(
    state: State<'_, AppState>,
) -> Result<Option<McpServerConfig>, BackendError> {
    Ok(state.browser_manager.mcp_server_config())
}

#[tauri::command]
pub async fn navigate_browser(
    state: State<'_, AppState>,
    url: String,
) -> Result<(), BackendError> {
    state
        .browser_manager
        .navigate(&url)
        .await
        .map_err(|e| BackendError::new(ErrorCode::RuntimeError, e))
}

#[tauri::command]
pub async fn browser_click(
    state: State<'_, AppState>,
    selector: String,
) -> Result<(), BackendError> {
    state
        .browser_manager
        .click(&selector)
        .await
        .map_err(|e| BackendError::new(ErrorCode::RuntimeError, e))
}

#[tauri::command]
pub async fn browser_fill(
    state: State<'_, AppState>,
    selector: String,
    value: String,
) -> Result<(), BackendError> {
    state
        .browser_manager
        .fill(&selector, &value)
        .await
        .map_err(|e| BackendError::new(ErrorCode::RuntimeError, e))
}

#[tauri::command]
pub async fn browser_scroll(
    state: State<'_, AppState>,
    delta_x: i32,
    delta_y: i32,
) -> Result<(), BackendError> {
    state
        .browser_manager
        .scroll(delta_x, delta_y)
        .await
        .map_err(|e| BackendError::new(ErrorCode::RuntimeError, e))
}

#[tauri::command]
pub async fn browser_reload(
    state: State<'_, AppState>,
) -> Result<(), BackendError> {
    state
        .browser_manager
        .reload()
        .await
        .map_err(|e| BackendError::new(ErrorCode::RuntimeError, e))
}

#[tauri::command]
pub async fn browser_go_back(
    state: State<'_, AppState>,
) -> Result<(), BackendError> {
    state
        .browser_manager
        .go_back()
        .await
        .map_err(|e| BackendError::new(ErrorCode::RuntimeError, e))
}

#[tauri::command]
pub async fn browser_go_forward(
    state: State<'_, AppState>,
) -> Result<(), BackendError> {
    state
        .browser_manager
        .go_forward()
        .await
        .map_err(|e| BackendError::new(ErrorCode::RuntimeError, e))
}
