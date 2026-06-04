use std::sync::Arc;

use chrono::Utc;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};

use crate::{
    agent_adapters::{acp::AcpAdapter, compat::CompatAdapter, AgentAdapter},
    capability_services::{mcp::{McpConnectionManager, McpRegistry}, policy::PolicyEngine, skills::SkillRegistry},
    domain::*,
    storage::Database,
};

// Re-export types from the types module
pub mod event_bus;
pub mod projector;
pub mod recovery;
pub mod session;
pub mod session_manager;
pub mod snapshot_manager;
pub mod snapshot_model;
pub mod state_cache;
pub mod stream_processor;
pub mod turn;
pub mod types;

use session_manager::{default_prompt_capabilities, SessionManager};
use snapshot_manager::update_snapshot_field;
use snapshot_model::RuntimeSnapshotState;
use state_cache::StateCache;
pub use types::{ActiveStreamMessage, EventEmitter, ManagedSession, RuntimeError, RuntimeResult};

/**
 * Runtime manages the lifecycle and state of agent conversation sessions.
 *
 * State management is delegated to `StateCache`, which handles:
 * - `runtime_states` - Conversation runtime state cache
 * - `streaming_messages` - Active streaming message buffers
 * - `terminal_records_cache` - Terminal output cache
 *
 * # State Update Ordering
 *
 * When updating both in-memory state and database:
 * 1. First update in-memory state (via StateCache)
 * 2. Then persist to database
 * 3. Finally emit events to frontend
 *
 * This ordering ensures that:
 * - Frontend receives events after state is consistent
 * - Database can be used for recovery if in-memory state is lost
 * - State queries during event processing see consistent data
 */
#[derive(Clone)]
pub struct Runtime {
    db: Database,
    mcp_registry: McpRegistry,
    mcp_conn_manager: McpConnectionManager,
    skill_registry: SkillRegistry,
    policy_engine: PolicyEngine,
    pub event_bus: Arc<event_bus::EventBus>,
    session_manager: SessionManager,
    state_cache: StateCache,
}

impl Runtime {
    pub fn new(db: Database) -> Self {
        let event_bus = Arc::new(event_bus::EventBus::new());
        let mut mcp_registry = McpRegistry::new(db.clone());
        // Wire MCP registry to event bus for status change events
        {
            let eb = event_bus.clone();
            mcp_registry.attach_emitter(Arc::new(move |event: &str, payload: serde_json::Value| {
                eb.broadcast(event, &payload);
            }));
        }
        Self {
            mcp_conn_manager: McpConnectionManager::new(mcp_registry.clone(), String::new()),
            mcp_registry,
            skill_registry: SkillRegistry::new(db.clone()),
            policy_engine: PolicyEngine::new(db.clone()),
            db,
            event_bus,
            session_manager: SessionManager::new(),
            state_cache: StateCache::new(),
        }
    }

    /// Get a reference to the MCP registry.
    pub fn mcp_registry(&self) -> &McpRegistry {
        &self.mcp_registry
    }

    /// Register a builtin MCP provider with the MCP registry.
    /// The provider closure is called each time MCP servers are resolved.
    pub fn register_builtin_mcp_provider(
        &self,
        provider: impl Fn() -> Option<McpServerConfig> + Send + Sync + 'static,
    ) {
        self.mcp_registry
            .add_builtin_provider(Arc::new(provider));
    }

    /// Get a reference to the MCP connection manager.
    pub fn mcp_connection_manager(&self) -> &McpConnectionManager {
        &self.mcp_conn_manager
    }

    /// Start persistent connections for all enabled MCP servers in a workspace.
    pub fn start_mcp_connections(&self, workspace_id: &str) {
        self.mcp_conn_manager.reload_all(workspace_id);
    }

    /// Stop all persistent MCP connections.
    pub fn stop_mcp_connections(&self) {
        self.mcp_conn_manager.stop_all();
    }

    /// Set the browser MCP provider callback (convenience wrapper).
    pub fn set_browser_mcp_provider(
        &self,
        provider: impl Fn() -> Option<McpServerConfig> + Send + Sync + 'static,
    ) {
        self.register_builtin_mcp_provider(provider);
    }

    /// Resolve MCP servers for a workspace, including builtin providers.
    /// Only returns enabled servers.
    pub fn resolve_mcp_servers(&self, workspace_id: &str) -> RuntimeResult<Vec<McpServerConfig>> {
        let servers = self.mcp_registry.resolve_all(workspace_id)?;
        tracing::info!(
            "Resolved {} MCP servers for workspace {}",
            servers.len(),
            workspace_id
        );
        Ok(servers)
    }

    /// Filter MCP servers by the agent's declared MCP transport capabilities.
    /// If the agent declares `mcpCapabilities`, only servers with supported
    /// transport types are retained. If no capabilities are declared, all servers pass.
    pub fn filter_mcp_by_agent_caps(
        &self,
        servers: Vec<McpServerConfig>,
        capabilities_cache: &serde_json::Value,
    ) -> Vec<McpServerConfig> {
        let caps = match serde_json::from_value::<AgentCapabilities>(capabilities_cache.clone()) {
            Ok(caps) => caps,
            Err(_) => return servers,
        };
        let mcp_caps = match caps.mcp_capabilities {
            Some(caps) => caps,
            None => return servers,
        };
        servers
            .into_iter()
            .filter(|s| match s.transport_type {
                crate::domain::McpTransportType::Stdio => mcp_caps.stdio,
                crate::domain::McpTransportType::Sse => mcp_caps.sse,
                crate::domain::McpTransportType::Http => mcp_caps.http,
                crate::domain::McpTransportType::Acp => mcp_caps.acp,
            })
            .collect()
    }

    pub fn attach_emitter(&self, emitter: EventEmitter) {
        let sink = Arc::new(event_bus::ClosureEventSink::new(move |event: &str, payload: &Value| {
            emitter(event, payload.clone());
        }));
        self.event_bus.register(sink);
    }

    pub fn is_session_in_memory(&self, conversation_id: &str) -> bool {
        self.session_manager.is_session_in_memory(conversation_id)
    }

    fn runtime_state(&self, conversation_id: &str) -> ConversationRuntimeState {
        self.state_cache.get_runtime_state(conversation_id, self.is_session_in_memory(conversation_id))
    }

    fn set_runtime_state(
        &self,
        conversation_id: &str,
        runtime: ConversationRuntimeState,
    ) -> RuntimeResult<()> {
        self.state_cache.set_runtime_state(conversation_id, runtime.clone());
        self.db
            .update_conversation_status(conversation_id, StateCache::derive_display_status(&runtime))?;
        Ok(())
    }

    fn update_runtime_state<F>(&self, conversation_id: &str, update: F) -> RuntimeResult<()>
    where
        F: FnOnce(&mut ConversationRuntimeState),
    {
        let is_hot = self.is_session_in_memory(conversation_id);
        let mut runtime = self.state_cache.get_runtime_state(conversation_id, is_hot);
        update(&mut runtime);
        runtime.last_transition_at = Utc::now();
        self.set_runtime_state(conversation_id, runtime)
    }

    pub async fn probe_agent_profile(&self, profile_id: &str) -> RuntimeResult<AgentCapabilities> {
        let profile = self.db.get_agent_profile(profile_id)?;
        let capabilities = self.adapter_for(&profile).initialize(&profile).await?;
        self.db
            .update_agent_capabilities(profile_id, &capabilities)?;
        self.emit(
            "agent:profile_probed",
            &json!({ "profile_id": profile_id, "capabilities": capabilities }),
        );
        Ok(capabilities)
    }

    pub async fn list_discovered_sessions(
        &self,
        workspace_id: &str,
        agent_profile_id: &str,
        scope: &str,
    ) -> RuntimeResult<Vec<ExternalSession>> {
        let workspace = self.db.get_workspace(workspace_id)?;
        let profile = self.db.get_agent_profile(agent_profile_id)?;
        let cwd = if scope == "all" {
            None
        } else {
            Some(workspace.cwd.as_str())
        };
        let sessions = timeout(
            Duration::from_secs(3),
            self.adapter_for(&profile).list_sessions(&profile, cwd),
        )
        .await
        .map_err(|_| RuntimeError::SessionDiscoveryTimeout)??;
        Ok(sessions)
    }

    pub async fn set_session_config(
        &self,
        input: SessionConfigInput,
    ) -> RuntimeResult<Vec<SessionConfigOption>> {
        let conversation = self.db.get_conversation(&input.conversation_id)?;
        let profile = self.db.get_agent_profile(&conversation.agent_profile_id)?;
        let binding = self
            .db
            .get_binding(&input.conversation_id)?
            .ok_or_else(|| RuntimeError::MissingBinding)?;
        let config_options = match self.session_runtime(&input.conversation_id, binding.clone())? {
            ManagedSession::Acp(session) => {
                session
                    .set_config_option(&input.config_id, &input.value)
                    .await?
            }
            ManagedSession::Passive(handle) => {
                self.adapter_for(&profile)
                    .set_config_option(&profile, &handle, &input.config_id, &input.value)
                    .await?
            }
        };
        self.record_lifecycle_event(
            &input.conversation_id,
            "SessionConfigChanged",
            json!({
                "config_id": input.config_id,
                "value": input.value
            }),
        )?;
        self.update_snapshot_config_options(&input.conversation_id, config_options.clone())?;
        self.emit_conversation_state(&input.conversation_id)?;
        Ok(config_options)
    }

    pub async fn set_model(&self, input: SetModelInput) -> RuntimeResult<AcpSessionModels> {
        let binding = self
            .db
            .get_binding(&input.conversation_id)?
            .ok_or_else(|| RuntimeError::MissingBinding)?;
        let models = match self.session_runtime(&input.conversation_id, binding.clone())? {
            ManagedSession::Acp(session) => session.set_model(&input.model_id).await?,
            ManagedSession::Passive(_) => {
                // Passive session cannot switch model via unstable API
                return Err(RuntimeError::InvalidState(
                    "passive session does not support model switching".to_string(),
                ));
            }
        };
        self.record_lifecycle_event(
            &input.conversation_id,
            "SessionModelChanged",
            json!({
                "model_id": input.model_id
            }),
        )?;
        let config_options = sync_model_selection_in_config_options(
            self.conversation_config_options(&input.conversation_id),
            &input.model_id,
        );
        self.update_snapshot_config_options(&input.conversation_id, config_options.clone())?;
        self.update_snapshot_models(&input.conversation_id, models.clone())?;
        self.emit(
            "conversation:config_updated",
            &json!({
                "conversation_id": input.conversation_id,
                "config_options": config_options,
                "models": models
            }),
        );
        Ok(models)
    }

    pub async fn set_mode(&self, input: SetModeInput) -> RuntimeResult<AcpSessionModeState> {
        let binding = self
            .db
            .get_binding(&input.conversation_id)?
            .ok_or_else(|| RuntimeError::MissingBinding)?;
        let modes = match self.session_runtime(&input.conversation_id, binding.clone())? {
            ManagedSession::Acp(session) => session.set_mode(&input.mode_id).await?,
            ManagedSession::Passive(_) => {
                return Err(RuntimeError::InvalidState(
                    "passive session does not support mode switching".to_string(),
                ));
            }
        };
        self.record_lifecycle_event(
            &input.conversation_id,
            "SessionModeChanged",
            json!({
                "mode_id": input.mode_id
            }),
        )?;
        self.update_snapshot_modes(&input.conversation_id, modes.clone())?;
        self.emit(
            "conversation:config_updated",
            &json!({
                "conversation_id": input.conversation_id,
                "modes": modes
            }),
        );
        self.emit_conversation_state(&input.conversation_id)?;
        Ok(modes)
    }

    pub async fn resolve_permission_request(
        &self,
        conversation_id: &str,
        tool_call_id: &str,
        fingerprint: &str,
        decision: PermissionDecisionKind,
    ) -> RuntimeResult<PermissionDecision> {
        let pending = self
            .db
            .get_pending_permission_by_tool_call(conversation_id, tool_call_id)?
            .ok_or_else(|| RuntimeError::PendingPermissionNotFound)?;
        if pending.status != PendingPermissionStatus::Pending {
            return Err(RuntimeError::PermissionNotPending);
        }
        if pending.fingerprint != fingerprint {
            return Err(RuntimeError::PermissionFingerprintMismatch);
        }
        let record =
            PolicyEngine::build_decision(conversation_id, tool_call_id, fingerprint, decision);
        let managed_session = self.session_manager.get(conversation_id);
        if let Some(ManagedSession::Acp(session)) = managed_session {
            session
                .resolve_permission(tool_call_id, record.decision.clone())
                .await?;
        }
        self.db.resolve_permission_atomic(&record, &pending.id)?;
        self.emit(
            "conversation:permission_resolved",
            &json!({ "conversation_id": conversation_id, "decision": record }),
        );
        Ok(record)
    }

    pub fn list_permissions(
        &self,
        conversation_id: &str,
    ) -> RuntimeResult<Vec<PermissionDecision>> {
        Ok(self.db.list_permissions(conversation_id)?)
    }

    pub fn refresh_workspace_skills(&self, workspace_id: &str) -> RuntimeResult<Vec<SkillRecord>> {
        let workspace = self.db.get_workspace(workspace_id)?;
        Ok(self.skill_registry.refresh_workspace_skills(&workspace)?)
    }

    fn adapter_for(&self, profile: &AgentProfile) -> Box<dyn AgentAdapter> {
        match profile.kind {
            AgentKind::Acp => Box::new(AcpAdapter),
            AgentKind::Compat => Box::new(CompatAdapter),
        }
    }

    fn session_runtime(
        &self,
        conversation_id: &str,
        fallback: AgentSessionBinding,
    ) -> RuntimeResult<ManagedSession> {
        // Capture by reference — the closure is only called on the cold path
        let runtime = self;
        let conv_id = conversation_id.to_string();
        self.session_manager
            .session_runtime(conversation_id, fallback, move || {
                let prompt_capabilities = runtime
                    .conversation_prompt_capabilities(&conv_id)
                    .unwrap_or_else(default_prompt_capabilities);
                let config_options = runtime
                    .conversation_state(&conv_id)
                    .ok()
                    .map(|state| state.config_options)
                    .unwrap_or_default();
                let models = runtime.conversation_models(&conv_id);
                let modes = runtime.conversation_modes(&conv_id);
                (prompt_capabilities, config_options, models, modes)
            })
    }

    fn emit<S: serde::Serialize>(&self, event: &str, payload: &S) {
        let value = serde_json::to_value(payload).unwrap_or_else(|_| json!({}));
        self.event_bus.broadcast(event, &value);
    }

    fn conversation_config_options(&self, conversation_id: &str) -> Vec<SessionConfigOption> {
        self.snapshot_parts(conversation_id).0
    }

    fn conversation_models(&self, conversation_id: &str) -> Option<AcpSessionModels> {
        self.snapshot_parts(conversation_id).1
    }

    fn conversation_modes(&self, conversation_id: &str) -> Option<AcpSessionModeState> {
        self.snapshot_parts(conversation_id).2
    }

    fn conversation_available_commands(&self, conversation_id: &str) -> Vec<AvailableCommand> {
        self.snapshot_parts(conversation_id).3
    }

    fn snapshot_parts(
        &self,
        conversation_id: &str,
    ) -> (
        Vec<SessionConfigOption>,
        Option<AcpSessionModels>,
        Option<AcpSessionModeState>,
        Vec<AvailableCommand>,
    ) {
        match self.snapshot_state(conversation_id) {
            Some(state) => (
                state.config_options,
                state.models,
                state.modes,
                state.available_commands,
            ),
            None => (Vec::new(), None, None, Vec::new()),
        }
    }

    fn snapshot_state(&self, conversation_id: &str) -> Option<RuntimeSnapshotState> {
        self.db
            .get_snapshot(conversation_id)
            .ok()
            .flatten()
            .and_then(|snapshot| RuntimeSnapshotState::from_snapshot_value(snapshot.state_json))
    }

    pub fn conversation_state(&self, conversation_id: &str) -> RuntimeResult<ConversationState> {
        let (config_options, models, modes, available_commands) =
            self.snapshot_parts(conversation_id);
        Ok(ConversationState {
            conversation: self.db.get_conversation(conversation_id)?,
            runtime: self.runtime_state(conversation_id),
            binding: self.db.get_binding(conversation_id)?,
            task_run: self.db.get_task_run(conversation_id)?,
            config_options,
            models,
            modes,
            available_commands,
            pending_permissions: self.db.list_pending_permissions(conversation_id)?,
        })
    }

    pub fn timeline(&self, conversation_id: &str) -> RuntimeResult<TimelineResponse> {
        Ok(TimelineResponse {
            events: self.db.list_events(conversation_id)?,
            messages: self.db.list_messages(conversation_id)?,
            tool_calls: self.db.list_tool_calls(conversation_id)?,
            pending_permissions: self.db.list_pending_permissions(conversation_id)?,
            terminals: self.db.list_terminals(conversation_id)?,
        })
    }

    pub(crate) fn emit_conversation_state(&self, conversation_id: &str) -> RuntimeResult<()> {
        let state = self.conversation_state(conversation_id)?;
        self.emit(
            "conversation:state_changed",
            &json!({ "conversation_id": conversation_id, "state": state }),
        );
        Ok(())
    }

    fn emit_task_run_state(&self, conversation_id: &str) -> RuntimeResult<()> {
        self.emit(
            "task_run:state_changed",
            &json!({ "conversation_id": conversation_id, "task_run": self.db.get_task_run(conversation_id)? }),
        );
        Ok(())
    }

    // Centralized storage summary seam for end-of-turn task status updates.
    // This avoids fetching full timeline projections on async hot paths.
    fn summarize_task_from_storage(
        &self,
        conversation_id: &str,
        status: &ConversationStatus,
    ) -> RuntimeResult<Option<String>> {
        match status {
            ConversationStatus::Cancelled => return Ok(Some("cancelled".to_string())),
            ConversationStatus::Failed => return Ok(Some("failed".to_string())),
            _ => {}
        }

        if let Some(text) = self.db.latest_agent_text(conversation_id)? {
            return Ok(Some(text));
        }

        if let Some(diff_payload) = self.db.latest_diff_payload(conversation_id)? {
            let summary = diff_payload
                .get("diffs")
                .map(|diffs| format!("completed with diff output: {}", diffs))
                .unwrap_or_else(|| "completed with diff output".to_string());
            return Ok(Some(summary));
        }

        let tool_call_count = self.db.count_tool_calls(conversation_id)?;
        if tool_call_count > 0 {
            return Ok(Some(format!(
                "completed with {} tool call(s)",
                tool_call_count
            )));
        }
        Ok(Some("completed".to_string()))
    }

    fn conversation_prompt_capabilities(
        &self,
        conversation_id: &str,
    ) -> Option<AgentPromptCapabilities> {
        let conversation = self.db.get_conversation(conversation_id).ok()?;
        let profile = self
            .db
            .get_agent_profile(&conversation.agent_profile_id)
            .ok()?;
        serde_json::from_value::<AgentCapabilities>(profile.capabilities_cache)
            .ok()
            .map(|capabilities| capabilities.prompt_capabilities)
    }

    fn update_snapshot_config_options(
        &self,
        conversation_id: &str,
        config_options: Vec<SessionConfigOption>,
    ) -> RuntimeResult<()> {
        update_snapshot_field(&self.db, conversation_id, |state| {
            state.config_options = config_options;
        })
    }

    fn update_snapshot_models(
        &self,
        conversation_id: &str,
        models: AcpSessionModels,
    ) -> RuntimeResult<()> {
        update_snapshot_field(&self.db, conversation_id, |state| {
            state.models = Some(models);
        })
    }

    fn update_snapshot_modes(
        &self,
        conversation_id: &str,
        modes: AcpSessionModeState,
    ) -> RuntimeResult<()> {
        update_snapshot_field(&self.db, conversation_id, |state| {
            state.modes = Some(modes);
        })
    }

    fn update_snapshot_available_commands(
        &self,
        conversation_id: &str,
        available_commands: Vec<AvailableCommand>,
    ) -> RuntimeResult<()> {
        update_snapshot_field(&self.db, conversation_id, |state| {
            state.available_commands = available_commands;
        })
    }
}

fn enum_text<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(ToOwned::to_owned))
        .unwrap_or_default()
}

fn sync_model_selection_in_config_options(
    config_options: Vec<SessionConfigOption>,
    model_id: &str,
) -> Vec<SessionConfigOption> {
    let next_value = Value::String(model_id.to_string());
    config_options
        .into_iter()
        .map(|mut option| {
            let is_model_option = option
                .category
                .as_deref()
                .map(|category| category.eq_ignore_ascii_case("model"))
                .unwrap_or(false)
                || option.id.to_lowercase().contains("model");

            if !is_model_option {
                return option;
            }

            option.current_value = next_value.clone();
            if let Some(raw) = option.raw.as_object_mut() {
                raw.insert("currentValue".to_string(), next_value.clone());
                raw.insert("selectedValue".to_string(), next_value.clone());
                raw.insert("value".to_string(), next_value.clone());
            }
            option
        })
        .collect()
}

/// Summarizes task timeline for display purposes.
///
/// Returns a human-readable summary based on the timeline content and status.
#[cfg_attr(not(test), allow(dead_code))]
pub fn summarize_task_timeline(
    timeline: &TimelineResponse,
    status: &ConversationStatus,
) -> Option<String> {
    let final_agent_text = timeline
        .messages
        .iter()
        .rev()
        .find(|message| message.role == MessageRole::Agent && message.kind == MessageKind::Text)
        .and_then(|message| {
            message
                .content_json
                .get("text")
                .and_then(serde_json::Value::as_str)
        })
        .map(ToOwned::to_owned);
    match status {
        ConversationStatus::Cancelled => Some("cancelled".to_string()),
        ConversationStatus::Failed => Some("failed".to_string()),
        _ => {
            if let Some(text) = final_agent_text {
                Some(text)
            } else if let Some(last_diff) = timeline
                .messages
                .iter()
                .rev()
                .find(|message| message.kind == MessageKind::Diff)
            {
                Some(
                    last_diff
                        .content_json
                        .get("diffs")
                        .map(|diffs| format!("completed with diff output: {}", diffs))
                        .unwrap_or_else(|| "completed with diff output".to_string()),
                )
            } else if !timeline.tool_calls.is_empty() {
                Some(format!(
                    "completed with {} tool call(s)",
                    timeline.tool_calls.len()
                ))
            } else {
                Some("completed".to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        AgentDisplaySource, AgentKind, AgentLaunchMode, AgentSessionBinding, AgentSessionSource,
        ConnectionPhase, Conversation, ConversationOrigin, ConversationRuntimeState,
        ConversationStatus, MessageKind, MessageProjection, MessageRole, SessionPhase,
        TimelineResponse, ToolCallProjection, TurnPhase,
    };
    use crate::runtime::snapshot_model::RuntimeSnapshotState;
    use crate::storage::Database;
    use chrono::Utc;
    use serde_json::json;
    use std::collections::BTreeMap;
    use uuid::Uuid;

    fn create_test_timeline() -> TimelineResponse {
        TimelineResponse {
            events: vec![],
            messages: vec![],
            tool_calls: vec![],
            pending_permissions: vec![],
            terminals: vec![],
        }
    }

    fn create_agent_message(text: &str) -> MessageProjection {
        MessageProjection {
            id: "msg_1".to_string(),
            conversation_id: "conv_1".to_string(),
            turn_id: "turn_1".to_string(),
            role: MessageRole::Agent,
            kind: MessageKind::Text,
            content_json: json!({ "text": text }),
            created_at: Utc::now(),
        }
    }

    fn create_diff_message(diffs: Vec<serde_json::Value>) -> MessageProjection {
        MessageProjection {
            id: "msg_1".to_string(),
            conversation_id: "conv_1".to_string(),
            turn_id: "turn_1".to_string(),
            role: MessageRole::Tool,
            kind: MessageKind::Diff,
            content_json: json!({ "diffs": diffs }),
            created_at: Utc::now(),
        }
    }

    fn create_tool_call(id: &str) -> ToolCallProjection {
        ToolCallProjection {
            id: format!("conv_1:{}", id),
            conversation_id: "conv_1".to_string(),
            turn_id: "turn_1".to_string(),
            tool_call_id: id.to_string(),
            title: "Test".to_string(),
            kind: crate::domain::ToolKind::Other,
            status: crate::domain::ToolCallStatus::Completed,
            raw_input_json: json!({}),
            raw_output_json: json!({}),
            content_json: json!([]),
            diffs_json: json!([]),
            terminal_ids_json: json!([]),
            locations_json: json!({}),
            started_at: Some(Utc::now()),
            ended_at: Some(Utc::now()),
        }
    }

    fn create_runtime_with_conversation() -> (Runtime, String) {
        let db = Database::new_in_memory().unwrap();
        let workspace = db.open_workspace("/tmp").unwrap();
        let profile = db
            .upsert_agent_profile(crate::domain::UpsertAgentProfileInput {
                id: Some("profile_1".to_string()),
                kind: AgentKind::Acp,
                name: "p".to_string(),
                command: "agent".to_string(),
                args: vec![],
                env: BTreeMap::new(),
                launch_mode: AgentLaunchMode::Native,
                runtime_preference: None,
                package_name: None,
                package_version: None,
                display_source: AgentDisplaySource::Native,
                enabled: true,
            })
            .unwrap();

        let now = Utc::now();
        let conversation = Conversation {
            id: Uuid::new_v4().to_string(),
            workspace_id: workspace.id,
            agent_profile_id: profile.id,
            origin: ConversationOrigin::OneagentManaged,
            status: ConversationStatus::Connected,
            title: "test".to_string(),
            created_at: now,
            updated_at: now,
            last_event_seq: 0,
            source: "oneagent".to_string(),
            channel_chat_id: None,
        };
        let binding = AgentSessionBinding {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation.id.clone(),
            adapter_kind: AgentKind::Acp,
            remote_session_id: "remote_1".to_string(),
            cwd: "/tmp".to_string(),
            load_supported: true,
            source: AgentSessionSource::New,
            last_synced_at: now,
        };
        let state = crate::domain::ConversationState {
            conversation: conversation.clone(),
            runtime: ConversationRuntimeState {
                connection_phase: ConnectionPhase::Ready,
                session_phase: SessionPhase::Hot,
                turn_phase: TurnPhase::Idle,
                last_error: None,
                last_transition_at: now,
            },
            binding: Some(binding.clone()),
            task_run: None,
            config_options: vec![],
            models: None,
            modes: None,
            available_commands: Vec::new(),
            pending_permissions: vec![],
        };

        db.create_conversation_atomic(
            &conversation,
            &binding,
            "ConversationCreated",
            &json!({}),
            &serde_json::to_value(RuntimeSnapshotState::from_conversation_state(&state)).unwrap(),
        )
        .unwrap();

        (Runtime::new(db), conversation.id)
    }

    #[test]
    fn summarize_task_returns_cancelled_for_cancelled_status() {
        let timeline = create_test_timeline();
        assert_eq!(
            summarize_task_timeline(&timeline, &ConversationStatus::Cancelled),
            Some("cancelled".to_string())
        );
    }

    #[test]
    fn summarize_task_returns_failed_for_failed_status() {
        let timeline = create_test_timeline();
        assert_eq!(
            summarize_task_timeline(&timeline, &ConversationStatus::Failed),
            Some("failed".to_string())
        );
    }

    #[test]
    fn summarize_task_returns_final_agent_text() {
        let timeline = TimelineResponse {
            events: vec![],
            messages: vec![
                create_agent_message("First message"),
                create_agent_message("Second message"),
            ],
            tool_calls: vec![],
            pending_permissions: vec![],
            terminals: vec![],
        };
        assert_eq!(
            summarize_task_timeline(&timeline, &ConversationStatus::Connected),
            Some("Second message".to_string())
        );
    }

    #[test]
    fn summarize_task_falls_back_to_diff_message() {
        let timeline = TimelineResponse {
            events: vec![],
            messages: vec![create_diff_message(vec![json!({"path": "file.rs"})])],
            tool_calls: vec![],
            pending_permissions: vec![],
            terminals: vec![],
        };
        let result = summarize_task_timeline(&timeline, &ConversationStatus::Connected);
        assert!(result.is_some());
        assert!(result.unwrap().contains("diff"));
    }

    #[test]
    fn summarize_task_falls_back_to_tool_call_count() {
        let timeline = TimelineResponse {
            events: vec![],
            messages: vec![],
            tool_calls: vec![create_tool_call("call_1"), create_tool_call("call_2")],
            pending_permissions: vec![],
            terminals: vec![],
        };
        assert_eq!(
            summarize_task_timeline(&timeline, &ConversationStatus::Connected),
            Some("completed with 2 tool call(s)".to_string())
        );
    }

    #[test]
    fn summarize_task_returns_completed_as_final_fallback() {
        let timeline = create_test_timeline();
        assert_eq!(
            summarize_task_timeline(&timeline, &ConversationStatus::Connected),
            Some("completed".to_string())
        );
    }

    #[test]
    fn summarize_task_ignores_user_messages() {
        let user_message = MessageProjection {
            id: "msg_1".to_string(),
            conversation_id: "conv_1".to_string(),
            turn_id: "turn_1".to_string(),
            role: MessageRole::User,
            kind: MessageKind::Text,
            content_json: json!({ "text": "user message" }),
            created_at: Utc::now(),
        };
        let agent_message = create_agent_message("agent response");
        let timeline = TimelineResponse {
            events: vec![],
            messages: vec![user_message, agent_message],
            tool_calls: vec![],
            pending_permissions: vec![],
            terminals: vec![],
        };
        assert_eq!(
            summarize_task_timeline(&timeline, &ConversationStatus::Connected),
            Some("agent response".to_string())
        );
    }

    #[test]
    fn terminal_output_is_accumulated_across_chunks() {
        let (runtime, conversation_id) = create_runtime_with_conversation();
        let turn_id = "turn_terminal";

        runtime
            .project_terminal_event(
                &conversation_id,
                turn_id,
                "term_1".to_string(),
                "running".to_string(),
                Some("/tmp".to_string()),
                Some("echo".to_string()),
                json!(["hello"]),
                Some("stdout".to_string()),
                Some("hel".to_string()),
                None,
            )
            .unwrap();
        runtime
            .project_terminal_event(
                &conversation_id,
                turn_id,
                "term_1".to_string(),
                "running".to_string(),
                None,
                None,
                json!([]),
                Some("stdout".to_string()),
                Some("lo".to_string()),
                None,
            )
            .unwrap();

        let terminal = runtime
            .db
            .get_terminal_by_remote_id(&conversation_id, "term_1")
            .unwrap()
            .unwrap();
        assert_eq!(terminal.stdout_buffer, "hello");
    }

    #[test]
    fn tool_call_projection_writes_diff_message_and_completed_state() {
        let (runtime, conversation_id) = create_runtime_with_conversation();
        let turn_id = "turn_tool";

        runtime
            .project_tool_call(
                &conversation_id,
                turn_id,
                "call_1".to_string(),
                "Run".to_string(),
                crate::domain::ToolKind::Execute,
                crate::domain::ToolCallStatus::Completed,
                json!({ "cmd": "echo hi" }),
                json!({ "text": "hi" }),
                json!([]),
                json!([{ "path": "src/main.rs" }]),
                json!(["term_1"]),
                crate::domain::AcpToolCallLocations::default(),
            )
            .unwrap();

        let calls = runtime.db.list_tool_calls(&conversation_id).unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].status, crate::domain::ToolCallStatus::Completed);
        assert!(calls[0].ended_at.is_some());

        let messages = runtime.db.list_messages(&conversation_id).unwrap();
        assert!(messages
            .iter()
            .any(|m| m.kind == MessageKind::Diff && m.role == MessageRole::Tool));
    }

    #[test]
    fn message_chunk_then_complete_produces_final_non_stream_message() {
        let (runtime, conversation_id) = create_runtime_with_conversation();
        let turn_id = "turn_msg";

        runtime
            .project_message_chunk(
                &conversation_id,
                turn_id,
                "agent".to_string(),
                "Hel".to_string(),
            )
            .unwrap();
        runtime
            .project_message_complete(
                &conversation_id,
                turn_id,
                "agent".to_string(),
                "Hello".to_string(),
            )
            .unwrap();

        let messages = runtime.db.list_messages(&conversation_id).unwrap();
        let final_msg = messages
            .iter()
            .find(|m| m.turn_id == turn_id && m.kind == MessageKind::Text)
            .cloned()
            .unwrap();
        assert_eq!(final_msg.content_json["stream"], json!(false));
        assert_eq!(final_msg.content_json["text"], json!("Hello"));
    }
}
