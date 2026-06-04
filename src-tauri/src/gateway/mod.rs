use std::sync::Arc;

use crate::{
    application::{ApplicationError, ApplicationServices},
    domain::*,
    runtime::Runtime,
    storage::{Database, StorageError},
};

#[derive(thiserror::Error, Debug)]
pub enum GatewayError {
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
    #[error("application error: {0}")]
    Application(#[from] ApplicationError),
    #[error("runtime error: {0}")]
    Runtime(#[from] crate::runtime::RuntimeError),
    #[error("validation error: {0}")]
    Validation(String),
}

pub type GatewayResult<T> = Result<T, GatewayError>;

#[derive(Clone)]
pub struct Gateway {
    pub db: Database,
    pub runtime: Arc<Runtime>,
    app: ApplicationServices,
}

impl Gateway {
    pub fn new(db: Database) -> GatewayResult<Self> {
        let runtime = Arc::new(Runtime::new(db.clone()));
        Ok(Self {
            app: ApplicationServices::new(db.clone(), runtime.clone()),
            runtime,
            db,
        })
    }

    pub fn attach_emitter(&self, emitter: crate::runtime::EventEmitter) {
        self.runtime.attach_emitter(emitter);
    }

    pub fn refresh_agent_discovery(&self) -> GatewayResult<Vec<AgentProfile>> {
        Ok(self.app.agents.refresh_agent_discovery()?)
    }

    pub fn list_agent_profiles(&self) -> GatewayResult<Vec<AgentProfile>> {
        Ok(self.app.agents.list_agent_profiles()?)
    }

    pub fn list_agent_discovery_status(&self) -> GatewayResult<Vec<AgentDiscoveryStatus>> {
        Ok(self.app.agents.list_agent_discovery_status()?)
    }

    pub fn upsert_agent_profile(
        &self,
        input: UpsertAgentProfileInput,
    ) -> GatewayResult<AgentProfile> {
        Ok(self.app.agents.upsert_agent_profile(input)?)
    }

    pub async fn probe_agent_profile(&self, profile_id: &str) -> GatewayResult<AgentCapabilities> {
        Ok(self.runtime.probe_agent_profile(profile_id).await?)
    }

    pub fn list_workspaces(&self) -> GatewayResult<Vec<Workspace>> {
        Ok(self.app.workspaces.list_workspaces()?)
    }

    pub fn open_workspace(&self, cwd: &str) -> GatewayResult<Workspace> {
        Ok(self.app.workspaces.open_workspace(cwd)?)
    }

    pub fn archive_workspace(&self, workspace_id: &str) -> GatewayResult<()> {
        Ok(self.app.workspaces.archive_workspace(workspace_id)?)
    }

    pub fn list_conversations(
        &self,
        workspace_id: &str,
        filter: ConversationFilter,
    ) -> GatewayResult<Vec<Conversation>> {
        Ok(self
            .app
            .conversations
            .list_conversations(workspace_id, filter)?)
    }

    pub fn search_conversations(
        &self,
        input: SearchConversationsInput,
    ) -> GatewayResult<Vec<Conversation>> {
        Ok(self.app.conversations.search_conversations(input)?)
    }

    pub async fn list_discovered_sessions(
        &self,
        workspace_id: &str,
        agent_profile_id: &str,
        scope: &str,
    ) -> GatewayResult<Vec<ExternalSession>> {
        Ok(self
            .app
            .workspaces
            .list_discovered_sessions(workspace_id, agent_profile_id, scope)
            .await?)
    }

    pub async fn create_conversation(
        &self,
        input: CreateConversationInput,
    ) -> GatewayResult<ConversationState> {
        Ok(self.app.conversations.create_conversation(input).await?)
    }

    pub async fn preview_session_config(
        &self,
        input: PreviewSessionConfigInput,
    ) -> GatewayResult<PreviewSessionConfigResult> {
        Ok(self.app.conversations.preview_session_config(input).await?)
    }

    pub async fn import_conversation(
        &self,
        workspace_id: &str,
        agent_profile_id: &str,
        remote_session_id: &str,
    ) -> GatewayResult<ConversationState> {
        Ok(self
            .app
            .conversations
            .import_conversation(workspace_id, agent_profile_id, remote_session_id)
            .await?)
    }

    pub async fn create_task_run(
        &self,
        input: CreateTaskRunInput,
    ) -> GatewayResult<ConversationState> {
        Ok(self.app.task_runs.create_task_run(input).await?)
    }

    pub async fn send_user_message(
        &self,
        conversation_id: &str,
        text: &str,
        attachments: Vec<AttachmentInput>,
    ) -> GatewayResult<TimelineResponse> {
        Ok(self
            .app
            .conversations
            .send_user_message(conversation_id, text, attachments)
            .await?)
    }

    pub async fn cancel_turn(&self, conversation_id: &str) -> GatewayResult<()> {
        Ok(self.app.conversations.cancel_turn(conversation_id).await?)
    }

    pub async fn delete_conversation(&self, conversation_id: &str) -> GatewayResult<()> {
        Ok(self
            .app
            .conversations
            .delete_conversation(conversation_id)
            .await?)
    }

    pub async fn set_session_config(
        &self,
        input: SessionConfigInput,
    ) -> GatewayResult<Vec<SessionConfigOption>> {
        Ok(self.app.conversations.set_session_config(input).await?)
    }

    pub async fn set_model(&self, input: SetModelInput) -> GatewayResult<AcpSessionModels> {
        Ok(self.app.conversations.set_model(input).await?)
    }

    pub async fn set_mode(&self, input: SetModeInput) -> GatewayResult<AcpSessionModeState> {
        Ok(self.app.conversations.set_mode(input).await?)
    }

    pub fn persist_attachment_blob(
        &self,
        input: PersistAttachmentBlobInput,
    ) -> GatewayResult<PersistAttachmentBlobOutput> {
        Ok(self.app.attachments.persist_attachment_blob(input)?)
    }

    pub fn list_permissions(
        &self,
        conversation_id: &str,
    ) -> GatewayResult<Vec<PermissionDecision>> {
        Ok(self.app.permissions.list_permissions(conversation_id)?)
    }

    pub async fn resolve_permission_request(
        &self,
        conversation_id: &str,
        tool_call_id: &str,
        fingerprint: &str,
        decision: PermissionDecisionKind,
    ) -> GatewayResult<PermissionDecision> {
        Ok(self
            .app
            .permissions
            .resolve_permission_request(conversation_id, tool_call_id, fingerprint, decision)
            .await?)
    }

    pub fn list_workspace_mcp(&self, workspace_id: &str) -> GatewayResult<Vec<McpServerConfig>> {
        Ok(self.app.workspaces.list_workspace_mcp(workspace_id)?)
    }

    pub fn upsert_workspace_mcp(&self, config: McpServerConfig) -> GatewayResult<McpServerConfig> {
        Ok(self.app.workspaces.upsert_workspace_mcp(config)?)
    }

    pub fn delete_workspace_mcp(&self, id: &str) -> GatewayResult<()> {
        Ok(self.app.workspaces.delete_workspace_mcp(id)?)
    }

    pub async fn test_mcp_connection(
        &self,
        config: McpServerConfig,
    ) -> GatewayResult<McpServerStatus> {
        Ok(self.app.workspaces.test_mcp_connection(config).await?)
    }

    pub async fn import_mcp_configs(
        &self,
        workspace_id: &str,
        json_string: &str,
    ) -> GatewayResult<Vec<McpServerConfig>> {
        Ok(self
            .app
            .workspaces
            .import_mcp_configs(workspace_id, json_string)
            .await?)
    }

    /// Reload a specific MCP server connection with updated configuration.
    pub fn reload_mcp_connection(&self, config: McpServerConfig) -> GatewayResult<()> {
        self.runtime.mcp_connection_manager().reload_connection(config);
        Ok(())
    }

    /// Reload all MCP connections for a workspace.
    pub fn reload_all_mcp_connections(&self, workspace_id: &str) -> GatewayResult<()> {
        self.runtime.mcp_connection_manager().reload_all(workspace_id);
        Ok(())
    }

    /// Get MCP connection status for all servers in a workspace.
    pub fn get_mcp_connection_status(&self, workspace_id: &str) -> GatewayResult<Vec<McpServerStatus>> {
        let _ = workspace_id;
        Ok(self.runtime.mcp_registry().get_all_statuses())
    }

    pub fn list_workspace_skills(&self, workspace_id: &str) -> GatewayResult<Vec<SkillRecord>> {
        Ok(self.app.workspaces.list_workspace_skills(workspace_id)?)
    }

    pub fn get_conversation_timeline(
        &self,
        conversation_id: &str,
    ) -> GatewayResult<TimelineResponse> {
        Ok(self.app.conversations.timeline(conversation_id)?)
    }

    pub fn get_conversation_state(
        &self,
        conversation_id: &str,
    ) -> GatewayResult<ConversationState> {
        Ok(self.app.conversations.conversation_state(conversation_id)?)
    }

    pub fn list_task_runs(&self, workspace_id: &str) -> GatewayResult<Vec<TaskRun>> {
        Ok(self.app.task_runs.list_task_runs(workspace_id)?)
    }

    pub async fn bootstrap_workspace(
        &self,
        input: WorkspaceBootstrapInput,
    ) -> GatewayResult<WorkspaceBootstrap> {
        Ok(self.app.workspaces.bootstrap_workspace(input).await?)
    }
}
