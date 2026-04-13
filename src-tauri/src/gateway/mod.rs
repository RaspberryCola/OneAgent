use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::{
    capability_services::{
        agent_discovery::{claude_code_preset, discover_installed_agents, get_discovery_status},
        agent_launch::is_claude_bridge_profile,
    },
    domain::*,
    runtime::{Runtime, RuntimeResult},
    storage::{Database, StorageError},
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};

#[derive(thiserror::Error, Debug)]
pub enum GatewayError {
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
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
}

impl Gateway {
    pub fn new(db: Database) -> GatewayResult<Self> {
        Ok(Self {
            runtime: Arc::new(Runtime::new(db.clone())),
            db,
        })
    }

    pub fn attach_emitter(&self, emitter: crate::runtime::EventEmitter) {
        self.runtime.attach_emitter(emitter);
    }

    fn do_refresh_agent_discovery(&self) -> GatewayResult<Vec<AgentProfile>> {
        let discovered = discover_installed_agents();
        let discovered_ids = discovered
            .iter()
            .filter_map(|input| input.id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        let existing_profiles = self.db.list_agent_profiles()?;
        for profile in existing_profiles {
            if profile.id.starts_with("auto-")
                && !discovered_ids.contains(&profile.id)
                && !is_claude_bridge_profile(&profile)
                && !self.db.is_agent_profile_referenced(&profile.id)?
            {
                self.db.delete_agent_profile(&profile.id)?;
            }
        }
        let mut profiles = Vec::with_capacity(discovered.len() + 1);
        profiles.push(self.db.upsert_agent_profile(claude_code_preset())?);
        for input in discovered {
            profiles.push(self.db.upsert_agent_profile(input)?);
        }
        Ok(profiles)
    }

    pub fn refresh_agent_discovery(&self) -> GatewayResult<Vec<AgentProfile>> {
        self.do_refresh_agent_discovery()
    }

    pub fn list_agent_profiles(&self) -> GatewayResult<Vec<AgentProfile>> {
        self.refresh_agent_discovery()?;
        Ok(self.db.list_agent_profiles()?)
    }

    pub fn list_agent_discovery_status(&self) -> GatewayResult<Vec<AgentDiscoveryStatus>> {
        self.refresh_agent_discovery()?;
        let profiles = self.db.list_agent_profiles()?;
        let discovery = get_discovery_status();
        Ok(discovery
            .into_iter()
            .map(|mut status| {
                status.profile_id = profiles
                    .iter()
                    .find(|p| {
                        p.id == status.profile_id.clone().unwrap_or_default()
                            || (p.command == status.command && p.name == status.name)
                    })
                    .map(|p| p.id.clone());
                status
            })
            .collect())
    }

    pub fn upsert_agent_profile(
        &self,
        input: UpsertAgentProfileInput,
    ) -> GatewayResult<AgentProfile> {
        if input.command.trim().is_empty() {
            return Err(GatewayError::Validation(
                "agent command cannot be empty".to_string(),
            ));
        }
        Ok(self.db.upsert_agent_profile(input)?)
    }

    pub async fn probe_agent_profile(&self, profile_id: &str) -> GatewayResult<AgentCapabilities> {
        Ok(self.runtime.probe_agent_profile(profile_id).await?)
    }

    pub fn list_workspaces(&self) -> GatewayResult<Vec<Workspace>> {
        Ok(self.db.list_workspaces()?)
    }

    pub fn open_workspace(&self, cwd: &str) -> GatewayResult<Workspace> {
        let cwd = std::fs::canonicalize(cwd)
            .map_err(|e| GatewayError::Validation(format!("invalid workspace path: {e}")))?
            .to_string_lossy()
            .to_string();
        Ok(self.db.open_workspace(&cwd)?)
    }

    pub fn list_conversations(
        &self,
        workspace_id: &str,
        filter: ConversationFilter,
    ) -> GatewayResult<Vec<Conversation>> {
        Ok(self
            .db
            .list_conversations(workspace_id, filter.include_tasks)?)
    }

    pub fn search_conversations(
        &self,
        input: SearchConversationsInput,
    ) -> GatewayResult<Vec<Conversation>> {
        if input.query.trim().is_empty() {
            return Err(GatewayError::Validation(
                "search query cannot be empty".to_string(),
            ));
        }
        Ok(self
            .db
            .search_conversations(&input.workspace_id, &input.query, input.include_tasks)?)
    }

    pub async fn list_discovered_sessions(
        &self,
        workspace_id: &str,
        agent_profile_id: &str,
        scope: &str,
    ) -> GatewayResult<Vec<ExternalSession>> {
        Ok(self
            .runtime
            .list_discovered_sessions(workspace_id, agent_profile_id, scope)
            .await?)
    }

    pub async fn create_conversation(
        &self,
        input: CreateConversationInput,
    ) -> GatewayResult<ConversationState> {
        Ok(self.runtime.create_conversation(input).await?)
    }

    pub async fn preview_session_config(
        &self,
        input: PreviewSessionConfigInput,
    ) -> GatewayResult<PreviewSessionConfigResult> {
        Ok(self.runtime.preview_session_config(input).await?)
    }

    pub async fn import_conversation(
        &self,
        workspace_id: &str,
        agent_profile_id: &str,
        remote_session_id: &str,
    ) -> GatewayResult<ConversationState> {
        Ok(self
            .runtime
            .import_conversation(workspace_id, agent_profile_id, remote_session_id)
            .await?)
    }

    pub async fn create_task_run(
        &self,
        input: CreateTaskRunInput,
    ) -> GatewayResult<ConversationState> {
        Ok(self.runtime.create_task_run(input).await?)
    }

    pub async fn send_user_message(
        &self,
        conversation_id: &str,
        text: &str,
        attachments: Vec<AttachmentInput>,
    ) -> GatewayResult<TimelineResponse> {
        if text.trim().is_empty() {
            return Err(GatewayError::Validation(
                "message cannot be empty".to_string(),
            ));
        }
        Ok(self
            .runtime
            .send_user_message(conversation_id, text, attachments)
            .await?)
    }

    pub async fn cancel_turn(&self, conversation_id: &str) -> GatewayResult<()> {
        Ok(self.runtime.cancel_turn(conversation_id).await?)
    }

    pub async fn delete_conversation(&self, conversation_id: &str) -> GatewayResult<()> {
        Ok(self.runtime.delete_conversation(conversation_id).await?)
    }

    pub async fn set_session_config(
        &self,
        input: SessionConfigInput,
    ) -> GatewayResult<Vec<SessionConfigOption>> {
        Ok(self.runtime.set_session_config(input).await?)
    }

    pub async fn set_model(&self, input: SetModelInput) -> GatewayResult<AcpSessionModels> {
        Ok(self.runtime.set_model(input).await?)
    }

    pub async fn set_mode(&self, input: SetModeInput) -> GatewayResult<AcpSessionModeState> {
        Ok(self.runtime.set_mode(input).await?)
    }

    pub fn persist_attachment_blob(
        &self,
        input: PersistAttachmentBlobInput,
    ) -> GatewayResult<PersistAttachmentBlobOutput> {
        let bytes = BASE64_STANDARD
            .decode(input.base64_data.as_bytes())
            .map_err(|err| {
                GatewayError::Validation(format!("invalid attachment payload: {err}"))
            })?;
        let extension = input
            .mime_type
            .as_deref()
            .and_then(guess_extension_for_mime)
            .unwrap_or("bin");
        let filename = sanitize_attachment_name(&input.name);
        let stem = filename
            .rsplit_once('.')
            .map(|(base, _)| base.to_string())
            .unwrap_or(filename);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or_default();
        let path = std::env::temp_dir()
            .join("oneagent-attachments")
            .join(format!("{stem}-{timestamp}.{extension}"));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| {
                GatewayError::Validation(format!("failed to create temp attachment dir: {err}"))
            })?;
        }
        std::fs::write(&path, bytes).map_err(|err| {
            GatewayError::Validation(format!("failed to persist attachment: {err}"))
        })?;
        Ok(PersistAttachmentBlobOutput {
            path: path.to_string_lossy().to_string(),
        })
    }

    pub fn list_permissions(
        &self,
        conversation_id: &str,
    ) -> GatewayResult<Vec<PermissionDecision>> {
        Ok(self.runtime.list_permissions(conversation_id)?)
    }

    pub async fn resolve_permission_request(
        &self,
        conversation_id: &str,
        tool_call_id: &str,
        fingerprint: &str,
        decision: PermissionDecisionKind,
    ) -> GatewayResult<PermissionDecision> {
        Ok(self
            .runtime
            .resolve_permission_request(conversation_id, tool_call_id, fingerprint, decision)
            .await?)
    }

    pub fn list_workspace_mcp(&self, workspace_id: &str) -> GatewayResult<Vec<McpServerConfig>> {
        Ok(self.db.list_workspace_mcp(workspace_id)?)
    }

    pub fn upsert_workspace_mcp(&self, config: McpServerConfig) -> GatewayResult<McpServerConfig> {
        self.db.upsert_workspace_mcp(&config)?;
        Ok(config)
    }

    pub fn list_workspace_skills(&self, workspace_id: &str) -> GatewayResult<Vec<SkillRecord>> {
        Ok(self.runtime.refresh_workspace_skills(workspace_id)?)
    }

    pub fn get_conversation_timeline(
        &self,
        conversation_id: &str,
    ) -> GatewayResult<TimelineResponse> {
        Ok(self.runtime.timeline(conversation_id)?)
    }

    pub fn get_conversation_state(
        &self,
        conversation_id: &str,
    ) -> GatewayResult<ConversationState> {
        Ok(self.runtime.conversation_state(conversation_id)?)
    }

    pub fn list_task_runs(&self, workspace_id: &str) -> GatewayResult<Vec<TaskRun>> {
        Ok(self.db.list_task_runs(workspace_id)?)
    }

    pub async fn bootstrap_workspace(
        &self,
        input: WorkspaceBootstrapInput,
    ) -> GatewayResult<WorkspaceBootstrap> {
        let workspace = self.db.get_workspace(&input.workspace_id)?;
        self.refresh_agent_discovery()?;
        let agent_profiles = self.db.list_agent_profiles()?;
        let conversations = self.db.list_conversations(&input.workspace_id, true)?;
        let mcp = self.db.list_workspace_mcp(&input.workspace_id)?;
        let skills = self.runtime.refresh_workspace_skills(&input.workspace_id)?;
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

fn guess_extension_for_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "audio/mpeg" => Some("mp3"),
        "audio/wav" => Some("wav"),
        "audio/webm" => Some("webm"),
        "application/pdf" => Some("pdf"),
        "application/json" => Some("json"),
        "text/plain" => Some("txt"),
        _ => None,
    }
}

fn sanitize_attachment_name(name: &str) -> String {
    let candidate: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if candidate.is_empty() {
        "attachment".to_string()
    } else {
        candidate
    }
}

#[allow(dead_code)]
fn _assert_runtime_result<T>(value: RuntimeResult<T>) -> RuntimeResult<T> {
    value
}
