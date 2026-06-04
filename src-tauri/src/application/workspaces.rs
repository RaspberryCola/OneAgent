use std::sync::Arc;

use crate::{
    domain::{
        ConversationStatus, ExternalSession, McpServerConfig, McpServerStatus, SkillRecord,
        Workspace, WorkspaceBootstrap, WorkspaceBootstrapInput,
    },
    runtime::Runtime,
    storage::Database,
};

use super::{agents::AgentAppService, ApplicationError, ApplicationResult};

#[derive(Clone)]
pub struct WorkspaceAppService {
    db: Database,
    runtime: Arc<Runtime>,
    agents: AgentAppService,
}

impl WorkspaceAppService {
    pub fn new(db: Database, runtime: Arc<Runtime>, agents: AgentAppService) -> Self {
        Self {
            db,
            runtime,
            agents,
        }
    }

    pub fn list_workspaces(&self) -> ApplicationResult<Vec<Workspace>> {
        Ok(self.db.list_workspaces()?)
    }

    pub fn open_workspace(&self, cwd: &str) -> ApplicationResult<Workspace> {
        let cwd = std::fs::canonicalize(cwd)
            .map_err(|e| ApplicationError::Validation(format!("invalid workspace path: {e}")))?
            .to_string_lossy()
            .to_string();
        Ok(self.db.open_workspace(&cwd)?)
    }

    pub fn archive_workspace(&self, workspace_id: &str) -> ApplicationResult<()> {
        Ok(self.db.archive_workspace(workspace_id)?)
    }

    pub fn list_workspace_mcp(
        &self,
        workspace_id: &str,
    ) -> ApplicationResult<Vec<McpServerConfig>> {
        // Include builtin providers (e.g. Browser Use) in the list
        Ok(self.runtime.mcp_registry().list_with_builtins(workspace_id)?)
    }

    pub fn upsert_workspace_mcp(
        &self,
        config: McpServerConfig,
    ) -> ApplicationResult<McpServerConfig> {
        self.db.upsert_workspace_mcp(&config)?;
        Ok(config)
    }

    pub fn delete_workspace_mcp(&self, id: &str) -> ApplicationResult<()> {
        Ok(self.db.delete_workspace_mcp(id)?)
    }

    pub async fn test_mcp_connection(
        &self,
        config: McpServerConfig,
    ) -> ApplicationResult<McpServerStatus> {
        Ok(self.runtime.mcp_registry().test_connection(&config).await)
    }

    pub async fn import_mcp_configs(
        &self,
        workspace_id: &str,
        json_string: &str,
    ) -> ApplicationResult<Vec<McpServerConfig>> {
        let configs = crate::capability_services::mcp::parse_mcp_config_json(json_string, workspace_id)
            .map_err(ApplicationError::Validation)?;
        let mut results = Vec::new();
        for config in configs {
            self.db.upsert_workspace_mcp(&config)?;
            results.push(config);
        }
        Ok(results)
    }

    pub fn list_workspace_skills(&self, workspace_id: &str) -> ApplicationResult<Vec<SkillRecord>> {
        Ok(self.runtime.refresh_workspace_skills(workspace_id)?)
    }

    pub async fn list_discovered_sessions(
        &self,
        workspace_id: &str,
        agent_profile_id: &str,
        scope: &str,
    ) -> ApplicationResult<Vec<ExternalSession>> {
        Ok(self
            .runtime
            .list_discovered_sessions(workspace_id, agent_profile_id, scope)
            .await?)
    }

    pub async fn bootstrap_workspace(
        &self,
        input: WorkspaceBootstrapInput,
    ) -> ApplicationResult<WorkspaceBootstrap> {
        let workspace = self.db.get_workspace(&input.workspace_id)?;
        self.agents.refresh_agent_discovery()?;
        let agent_profiles = self.db.list_agent_profiles()?;
        let mut conversations = self.db.list_conversations(&input.workspace_id, true)?;

        for conversation in &mut conversations {
            if !self.runtime.is_session_in_memory(&conversation.id)
                && matches!(
                    conversation.status,
                    ConversationStatus::Connected
                        | ConversationStatus::Running
                        | ConversationStatus::Recovering
                        | ConversationStatus::Initializing
                        | ConversationStatus::Cancelling
                )
            {
                self.db
                    .update_conversation_status(&conversation.id, ConversationStatus::Sleep)?;
                conversation.status = ConversationStatus::Sleep;
            }
        }

        let mcp = self.list_workspace_mcp(&input.workspace_id)?;
        let skills = self.runtime.refresh_workspace_skills(&input.workspace_id)?;

        // Auto-start persistent MCP connections for this workspace
        self.runtime.start_mcp_connections(&input.workspace_id);
        let selected_agent_profile_id = input.agent_profile_id.clone().or_else(|| {
            agent_profiles
                .iter()
                .find(|profile| profile.enabled)
                .map(|profile| profile.id.clone())
        });
        let discovered_sessions = if let (Some(agent_profile_id), Some(discovered_scope)) = (
            selected_agent_profile_id.as_deref(),
            input.discovered_scope.as_deref(),
        ) {
            self.runtime
                .list_discovered_sessions(&input.workspace_id, agent_profile_id, discovered_scope)
                .await?
        } else {
            Vec::new()
        };
        Ok(WorkspaceBootstrap {
            workspace,
            agent_profiles,
            conversations,
            discovered_sessions,
            mcp,
            skills,
        })
    }
}
