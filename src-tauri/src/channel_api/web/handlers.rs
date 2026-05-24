use axum::{
    extract::{Path, State},
    http::{header, Response, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tracing::error;

use crate::{
    domain::*,
    channel_api::{ImportConversationInput, SendUserMessageInput, ResolvePermissionInput},
};
use super::ws::WebState;

#[derive(Deserialize)]
pub struct LoginRequest {
    pub password: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub token: String,
}

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

pub async fn login_handler(
    State(state): State<WebState>,
    Json(payload): Json<LoginRequest>,
) -> impl IntoResponse {
    if state.auth.verify_password(&payload.password) {
        match state.auth.create_jwt() {
            Ok(token) => {
                // Set cookie and return token
                let cookie = format!(
                    "token={}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800",
                    token
                );
                (
                    StatusCode::OK,
                    [(header::SET_COOKIE, cookie)],
                    Json(LoginResponse { token }),
                )
                    .into_response()
            }
            Err(e) => {
                error!("Failed to create JWT: {}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error").into_response()
            }
        }
    } else {
        (StatusCode::UNAUTHORIZED, "Invalid password").into_response()
    }
}

pub async fn logout_handler() -> impl IntoResponse {
    let cookie = "token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
    (StatusCode::OK, [(header::SET_COOKIE, cookie)], "OK")
}

pub async fn change_password_handler(
    State(state): State<WebState>,
    Json(payload): Json<ChangePasswordRequest>,
) -> impl IntoResponse {
    match state.auth.change_password(&payload.current_password, &payload.new_password) {
        Ok(_) => (StatusCode::OK, Json(json!({ "status": "ok" }))).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

// Helpers for deserializing optional fields or specific inputs
// Frontend sends camelCase via JS invoke args; rename_all matches Tauri's behavior.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeAgentProfileInput {
    profile_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenWorkspaceInput {
    cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListWorkspaceFilesInput {
    cwd: String,
    directory_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitDiffInput {
    cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListConversationsInput {
    workspace_id: String,
    filter: ConversationFilter,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListDiscoveredSessionsInput {
    workspace_id: String,
    agent_profile_id: String,
    scope: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelTurnInput {
    conversation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteConversationInput {
    conversation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListPermissionsInput {
    conversation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListWorkspaceMcpInput {
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListWorkspaceSkillsInput {
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetConversationTimelineInput {
    conversation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetConversationStateInput {
    conversation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListTaskRunsInput {
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnTerminalInput {
    id: String,
    cwd: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteToTerminalInput {
    id: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizeTerminalInput {
    id: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloseTerminalInput {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartImPluginInput {
    platform: String,
    sidecar_path: String,
    credentials_json: String,
    workspace_id: Option<String>,
    agent_profile_id: Option<String>,
    model_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateImPluginConfigInput {
    platform: String,
    workspace_id: Option<String>,
    agent_profile_id: Option<String>,
    model_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopImPluginInput {
    platform: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApproveImPairingInput {
    code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartWeixinLoginInput {
    sidecar_path: String,
}


/// Tauri's invoke extracts named parameters automatically (e.g. `{ input: {...} }` → the inner value).
/// The web handler receives the raw JSON body, so we need to unwrap single-key objects
/// to match Tauri's behavior — but only when the inner value is itself an object.
/// Scalar wraps like `{ conversationId: "abc" }` should pass through as-is.
fn unwrap_params(params: Value) -> Value {
    if let Value::Object(ref map) = params {
        if map.len() == 1 {
            if let Some(inner) = map.values().next() {
                if inner.is_object() {
                    return inner.clone();
                }
            }
        }
    }
    params
}

pub async fn invoke_handler(
    State(state): State<WebState>,
    Path(command): Path<String>,
    Json(params): Json<Value>,
) -> impl IntoResponse {
    let gateway = &state.gateway;
    let params = unwrap_params(params);

    let res: Result<Value, String> = async move {
        match command.as_str() {
            "bootstrap_workspace" => {
                let input: WorkspaceBootstrapInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.bootstrap_workspace(input).await.map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "list_agent_profiles" => {
                let output = gateway.list_agent_profiles().map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "list_agent_discovery_status" => {
                let output = gateway.list_agent_discovery_status().map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "refresh_agent_discovery" => {
                let output = gateway.refresh_agent_discovery().map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "upsert_agent_profile" => {
                let input: UpsertAgentProfileInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.upsert_agent_profile(input).map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "probe_agent_profile" => {
                let input: ProbeAgentProfileInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.probe_agent_profile(&input.profile_id).await.map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "list_workspaces" => {
                let output = gateway.list_workspaces().map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "open_workspace" => {
                let input: OpenWorkspaceInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.open_workspace(&input.cwd).map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "get_or_create_default_workspace" => {
                // Get the home directory
                let home_dir = dirs::home_dir().ok_or("Could not determine home directory")?;
                let oneagent_root = home_dir.join(".oneagent");
                let default_workspace_dir = oneagent_root.join("workspace");
                // Ensure oneagent root exists (for skills)
                if !oneagent_root.exists() {
                    std::fs::create_dir_all(&oneagent_root).map_err(|e| e.to_string())?;
                }
                // Create workspace subdirectory
                if !default_workspace_dir.exists() {
                    std::fs::create_dir_all(&default_workspace_dir).map_err(|e| e.to_string())?;
                }
                let cwd = default_workspace_dir.to_string_lossy().to_string();
                let output = gateway.open_workspace(&cwd).map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "list_workspace_files" => {
                let input: ListWorkspaceFilesInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                
                // Re-implement pick logic to resolve relative files
                let workspace_path = std::path::PathBuf::from(&input.cwd);
                if !workspace_path.exists() {
                    return Err(format!("Workspace path does not exist: {}", input.cwd));
                }
                let workspace_root = workspace_path.canonicalize().map_err(|e| e.to_string())?;
                let target_path = match input.directory_path {
                    Some(path) => std::path::PathBuf::from(path),
                    None => workspace_root.clone(),
                };
                let target_path = target_path.canonicalize().map_err(|e| e.to_string())?;
                if !target_path.starts_with(&workspace_root) {
                    return Err("Directory is outside workspace root".to_string());
                }

                let mut entries = Vec::new();
                let read_dir = std::fs::read_dir(&target_path).map_err(|e| e.to_string())?;
                for dir_entry in read_dir {
                    let entry = dir_entry.map_err(|e| e.to_string())?;
                    let path = entry.path();
                    let metadata = entry.metadata().map_err(|e| e.to_string())?;
                    let modified_at = metadata.modified().ok().map(chrono::DateTime::<chrono::Utc>::from);

                    entries.push(WorkspaceFileEntry {
                        name: entry.file_name().to_string_lossy().to_string(),
                        path: path.to_string_lossy().to_string(),
                        is_dir: metadata.is_dir(),
                        size_bytes: metadata.is_file().then_some(metadata.len()),
                        modified_at,
                    });
                }
                entries.sort_by(|left, right| {
                    right.is_dir.cmp(&left.is_dir)
                        .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
                });
                serde_json::to_value(entries).map_err(|e| e.to_string())
            }
            "git_diff" => {
                let input: GitDiffInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                
                async fn git_output(cwd: &str, args: &[&str]) -> Result<String, String> {
                    let mut cmd = tokio::process::Command::new("git");
                    cmd.args(args).current_dir(cwd);
                    #[cfg(target_os = "windows")]
                    {
                        use std::os::windows::process::CommandExt;
                        const CREATE_NO_WINDOW: u32 = 0x08000000;
                        cmd.creation_flags(CREATE_NO_WINDOW);
                    }
                    let o = cmd.output().await.map_err(|e| format!("Failed to run git: {e}"))?;
                    if o.status.success() || o.status.code() == Some(1) {
                        Ok(String::from_utf8_lossy(&o.stdout).to_string())
                    } else {
                        Err(String::from_utf8_lossy(&o.stderr).to_string())
                    }
                }
                let (unstaged, staged) = tokio::try_join!(
                    git_output(&input.cwd, &["diff"]),
                    git_output(&input.cwd, &["diff", "--cached"])
                )?;
                serde_json::to_value(GitDiffResult { unstaged, staged }).map_err(|e| e.to_string())
            }
            "list_conversations" => {
                let input: ListConversationsInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.list_conversations(&input.workspace_id, input.filter).map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "search_conversations" => {
                let input: SearchConversationsInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.search_conversations(input).map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "list_discovered_sessions" => {
                let input: ListDiscoveredSessionsInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.list_discovered_sessions(&input.workspace_id, &input.agent_profile_id, &input.scope).await.map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "create_conversation" => {
                let input: CreateConversationInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.create_conversation(input).await.map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "preview_session_config" => {
                let input: PreviewSessionConfigInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.preview_session_config(input).await.map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "import_conversation" => {
                let input: ImportConversationInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.import_conversation(&input.workspace_id, &input.agent_profile_id, &input.remote_session_id).await.map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "create_task_run" => {
                let input: CreateTaskRunInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.create_task_run(input).await.map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "send_user_message" => {
                let input: SendUserMessageInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.send_user_message(
                    &input.conversation_id,
                    &input.text,
                    input.attachments.unwrap_or_default(),
                ).await.map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "cancel_turn" => {
                let input: CancelTurnInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                gateway.cancel_turn(&input.conversation_id).await.map_err(|e| e.to_string())?;
                Ok(json!({ "status": "ok" }))
            }
            "delete_conversation" => {
                let input: DeleteConversationInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                gateway.delete_conversation(&input.conversation_id).await.map_err(|e| e.to_string())?;
                Ok(json!({ "status": "ok" }))
            }
            "set_session_config" => {
                let input: SessionConfigInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.set_session_config(input).await.map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "set_model" => {
                let input: SetModelInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.set_model(input).await.map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "set_mode" => {
                let input: SetModeInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.set_mode(input).await.map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "persist_attachment_blob" => {
                let input: PersistAttachmentBlobInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.persist_attachment_blob(input).map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "list_permissions" => {
                let input: ListPermissionsInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.list_permissions(&input.conversation_id).map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "resolve_permission_request" => {
                let input: ResolvePermissionInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.resolve_permission_request(
                    &input.conversation_id,
                    &input.tool_call_id,
                    &input.fingerprint,
                    input.decision,
                ).await.map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "list_workspace_mcp" => {
                let input: ListWorkspaceMcpInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.list_workspace_mcp(&input.workspace_id).map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "upsert_workspace_mcp" => {
                let config: McpServerConfig = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.upsert_workspace_mcp(config).map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "list_workspace_skills" => {
                let input: ListWorkspaceSkillsInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.list_workspace_skills(&input.workspace_id).map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "get_conversation_timeline" => {
                let input: GetConversationTimelineInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.get_conversation_timeline(&input.conversation_id).map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "get_conversation_state" => {
                let input: GetConversationStateInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.get_conversation_state(&input.conversation_id).map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "list_task_runs" => {
                let input: ListTaskRunsInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = gateway.list_task_runs(&input.workspace_id).map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "spawn_terminal" => {
                let input: SpawnTerminalInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                if let Some(app_handle) = &state.app_handle {
                    state.terminal_manager.spawn_session(input.id, input.cwd, app_handle.clone()).await.map_err(|e| e.to_string())?;
                    Ok(json!({ "status": "ok" }))
                } else {
                    Err("Terminal operations not supported in standalone web mode".to_string())
                }
            }
            "write_to_terminal" => {
                let input: WriteToTerminalInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                state.terminal_manager.write(&input.id, &input.data).await.map_err(|e| e.to_string())?;
                Ok(json!({ "status": "ok" }))
            }
            "resize_terminal" => {
                let input: ResizeTerminalInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                state.terminal_manager.resize(&input.id, input.cols, input.rows).await.map_err(|e| e.to_string())?;
                Ok(json!({ "status": "ok" }))
            }
            "close_terminal" => {
                let input: CloseTerminalInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                state.terminal_manager.close(&input.id).await.map_err(|e| e.to_string())?;
                Ok(json!({ "status": "ok" }))
            }
            "list_im_plugins" => {
                let output = crate::channel_api::im::list_im_plugins_impl(gateway, &state.im_manager).await.map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "start_im_plugin" => {
                let input: StartImPluginInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                crate::channel_api::im::start_im_plugin_impl(
                    gateway,
                    &state.im_manager,
                    input.platform,
                    input.sidecar_path,
                    input.credentials_json,
                    input.workspace_id,
                    input.agent_profile_id,
                    input.model_id,
                ).await.map_err(|e| e.to_string())?;
                Ok(json!({ "status": "ok" }))
            }
            "update_im_plugin_config" => {
                let input: UpdateImPluginConfigInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                crate::channel_api::im::update_im_plugin_config_impl(
                    gateway,
                    input.platform,
                    input.workspace_id,
                    input.agent_profile_id,
                    input.model_id,
                ).await.map_err(|e| e.to_string())?;
                Ok(json!({ "status": "ok" }))
            }
            "stop_im_plugin" => {
                let input: StopImPluginInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                crate::channel_api::im::stop_im_plugin_impl(
                    gateway,
                    &state.im_manager,
                    input.platform,
                ).await.map_err(|e| e.to_string())?;
                Ok(json!({ "status": "ok" }))
            }
            "approve_im_pairing" => {
                let input: ApproveImPairingInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let output = crate::channel_api::im::approve_im_pairing_impl(
                    gateway,
                    input.code,
                ).await.map_err(|e| e.to_string())?;
                serde_json::to_value(output).map_err(|e| e.to_string())
            }
            "start_weixin_login" => {
                let input: StartWeixinLoginInput = serde_json::from_value(params).map_err(|e| e.to_string())?;
                crate::channel_api::im::start_weixin_login_impl(
                    gateway,
                    &state.im_manager,
                    input.sidecar_path,
                ).await.map_err(|e| e.to_string())?;
                Ok(json!({ "status": "ok" }))
            }
            "stop_weixin_login" => {
                crate::channel_api::im::stop_weixin_login_impl(
                    &state.im_manager,
                ).await.map_err(|e| e.to_string())?;
                Ok(json!({ "status": "ok" }))
            }
            _ => Err(format!("Unknown command: {}", command)),
        }
    }.await;

    match res {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}
