use std::sync::Arc;

use serde::Deserialize;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::{domain::{BackendError, *}, gateway::Gateway};

#[derive(Clone)]
pub struct AppState {
    pub gateway: Arc<Gateway>,
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
pub async fn list_agent_profiles(state: State<'_, AppState>) -> Result<Vec<AgentProfile>, BackendError> {
    state.gateway.list_agent_profiles().map_err(BackendError::from)
}

#[tauri::command]
pub async fn list_agent_discovery_status(state: State<'_, AppState>) -> Result<Vec<AgentDiscoveryStatus>, BackendError> {
    state.gateway.list_agent_discovery_status().map_err(BackendError::from)
}

#[tauri::command]
pub async fn refresh_agent_discovery(state: State<'_, AppState>) -> Result<Vec<AgentProfile>, BackendError> {
    state.gateway.refresh_agent_discovery().map_err(BackendError::from)
}

#[tauri::command]
pub async fn upsert_agent_profile(
    state: State<'_, AppState>,
    input: UpsertAgentProfileInput,
) -> Result<AgentProfile, BackendError> {
    state.gateway.upsert_agent_profile(input).map_err(BackendError::from)
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
pub async fn open_workspace(state: State<'_, AppState>, cwd: String) -> Result<Workspace, BackendError> {
    state.gateway.open_workspace(&cwd).map_err(BackendError::from)
}

/// Get or create the default workspace at ~/.oneagent
#[tauri::command]
pub async fn get_or_create_default_workspace(
    state: State<'_, AppState>,
) -> Result<Workspace, BackendError> {
    // Get the home directory
    let home_dir = dirs::home_dir()
        .ok_or_else(|| BackendError::new(ErrorCode::InvalidWorkspacePath, "Could not determine home directory"))?;

    // Create ~/.oneagent directory
    let default_workspace_dir = home_dir.join(".oneagent");
    if !default_workspace_dir.exists() {
        std::fs::create_dir_all(&default_workspace_dir).map_err(|e| {
            BackendError::new(ErrorCode::InvalidWorkspacePath, format!("Failed to create default workspace directory: {e}"))
        })?;
    }

    // Open the workspace
    let cwd = default_workspace_dir.to_string_lossy().to_string();
    state.gateway.open_workspace(&cwd).map_err(BackendError::from)
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
            let workspace = state.gateway.open_workspace(&cwd).map_err(BackendError::from)?;
            Ok(Some(workspace))
        }
        None => Ok(None), // User cancelled the dialog
    }
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
    state
        .gateway
        .create_conversation(input)
        .await
        .map_err(BackendError::from)
}

#[tauri::command]
pub async fn preview_session_config(
    state: State<'_, AppState>,
    input: PreviewSessionConfigInput,
) -> Result<Vec<SessionConfigOption>, BackendError> {
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
        .import_conversation(&input.workspace_id, &input.agent_profile_id, &input.remote_session_id)
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
) -> Result<(), BackendError> {
    state
        .gateway
        .set_session_config(input)
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
