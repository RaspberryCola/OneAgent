use std::{collections::HashMap, sync::Arc};

use chrono::Utc;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};
use uuid::Uuid;

use crate::{
    agent_adapters::{
        acp::{AcpAdapter, AcpLiveSession},
        compat::CompatAdapter,
        AgentAdapter, AgentSessionHandle, LoadedSession, RuntimeStreamEvent,
    },
    capability_services::{mcp::McpRegistry, policy::PolicyEngine, skills::SkillRegistry},
    domain::*,
    storage::Database,
};

// Re-export types from the types module
pub mod event_bus;
pub mod projector;
pub mod recovery;
pub mod session_manager;
pub mod snapshot_model;
pub mod stream_processor;
pub mod types;

use session_manager::{default_prompt_capabilities, SessionManager};
use snapshot_model::RuntimeSnapshotState;
pub use types::{ActiveStreamMessage, EventEmitter, ManagedSession, RuntimeError, RuntimeResult};

#[derive(Clone)]
pub struct Runtime {
    db: Database,
    mcp_registry: McpRegistry,
    skill_registry: SkillRegistry,
    policy_engine: PolicyEngine,
    pub event_bus: Arc<event_bus::EventBus>,
    session_manager: SessionManager,
    runtime_states: Arc<Mutex<HashMap<String, ConversationRuntimeState>>>,
    streaming_messages: Arc<Mutex<HashMap<String, ActiveStreamMessage>>>,
    terminal_records_cache: Arc<Mutex<HashMap<String, TerminalRecord>>>,
}

impl Runtime {
    pub fn new(db: Database) -> Self {
        Self {
            mcp_registry: McpRegistry::new(db.clone()),
            skill_registry: SkillRegistry::new(db.clone()),
            policy_engine: PolicyEngine::new(db.clone()),
            db,
            event_bus: Arc::new(event_bus::EventBus::new()),
            session_manager: SessionManager::new(),
            runtime_states: Arc::new(Mutex::new(HashMap::new())),
            streaming_messages: Arc::new(Mutex::new(HashMap::new())),
            terminal_records_cache: Arc::new(Mutex::new(HashMap::new())),
        }
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

    fn default_runtime_state(&self, conversation_id: &str) -> ConversationRuntimeState {
        let session_phase = if self.is_session_in_memory(conversation_id) {
            SessionPhase::Hot
        } else {
            SessionPhase::Cold
        };
        let connection_phase = if session_phase == SessionPhase::Hot {
            ConnectionPhase::Ready
        } else {
            ConnectionPhase::Disconnected
        };
        ConversationRuntimeState {
            connection_phase,
            session_phase,
            turn_phase: TurnPhase::Idle,
            last_error: None,
            last_transition_at: Utc::now(),
        }
    }

    fn runtime_state(&self, conversation_id: &str) -> ConversationRuntimeState {
        self.runtime_states
            .lock()
            .get(conversation_id)
            .cloned()
            .unwrap_or_else(|| self.default_runtime_state(conversation_id))
    }

    fn derive_display_status(runtime: &ConversationRuntimeState) -> ConversationStatus {
        match runtime.turn_phase {
            TurnPhase::Cancelling => ConversationStatus::Cancelling,
            TurnPhase::Failed => ConversationStatus::Failed,
            TurnPhase::Running => ConversationStatus::Running,
            TurnPhase::Idle => match runtime.session_phase {
                SessionPhase::Loading => ConversationStatus::Recovering,
                SessionPhase::Hot => ConversationStatus::Connected,
                SessionPhase::Cold => match runtime.connection_phase {
                    ConnectionPhase::Initializing => ConversationStatus::Initializing,
                    ConnectionPhase::Disconnected | ConnectionPhase::Ready => {
                        ConversationStatus::Sleep
                    }
                },
            },
        }
    }

    fn set_runtime_state(
        &self,
        conversation_id: &str,
        mut runtime: ConversationRuntimeState,
    ) -> RuntimeResult<()> {
        runtime.last_transition_at = Utc::now();
        self.runtime_states
            .lock()
            .insert(conversation_id.to_string(), runtime.clone());
        self.db
            .update_conversation_status(conversation_id, Self::derive_display_status(&runtime))?;
        Ok(())
    }

    fn update_runtime_state<F>(&self, conversation_id: &str, update: F) -> RuntimeResult<()>
    where
        F: FnOnce(&mut ConversationRuntimeState),
    {
        let mut runtime = self.runtime_state(conversation_id);
        update(&mut runtime);
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
        .map_err(|_| {
            RuntimeError::InvalidState("agent session discovery timed out".to_string())
        })??;
        Ok(sessions)
    }

    pub async fn create_conversation(
        &self,
        input: CreateConversationInput,
    ) -> RuntimeResult<ConversationState> {
        let workspace = self.db.get_workspace(&input.workspace_id)?;
        let profile = self.db.get_agent_profile(&input.agent_profile_id)?;
        let mcp_servers = self.mcp_registry.list_for_workspace(&workspace.id)?;
        let (managed_session, startup_events) = match profile.kind {
            AgentKind::Acp => {
                let (session, events) =
                    AcpLiveSession::start_new(&profile, &workspace.cwd, &mcp_servers).await?;
                (ManagedSession::Acp(session), events)
            }
            AgentKind::Compat => (
                ManagedSession::Passive(
                    self.adapter_for(&profile)
                        .new_session(&profile, &workspace.cwd, &mcp_servers)
                        .await?,
                ),
                Vec::new(),
            ),
        };
        let handle = match &managed_session {
            ManagedSession::Acp(session) => session.handle.clone(),
            ManagedSession::Passive(handle) => handle.clone(),
        };
        let now = Utc::now();
        let conversation = Conversation {
            id: Uuid::new_v4().to_string(),
            workspace_id: workspace.id.clone(),
            agent_profile_id: profile.id.clone(),
            origin: ConversationOrigin::OneagentManaged,
            status: ConversationStatus::Initializing,
            title: input
                .title
                .unwrap_or_else(|| "New conversation".to_string()),
            created_at: now,
            updated_at: now,
            last_event_seq: 0,
            source: "oneagent".to_string(),
            channel_chat_id: None,
        };
        let binding = AgentSessionBinding {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation.id.clone(),
            adapter_kind: profile.kind.clone(),
            remote_session_id: handle.remote_session_id.clone(),
            cwd: handle.cwd.clone(),
            load_supported: handle.load_supported,
            source: AgentSessionSource::New,
            last_synced_at: Utc::now(),
        };
        let initial_runtime = ConversationRuntimeState {
            connection_phase: ConnectionPhase::Ready,
            session_phase: SessionPhase::Hot,
            turn_phase: TurnPhase::Idle,
            last_error: None,
            last_transition_at: Utc::now(),
        };
        let initial_state = ConversationState {
            conversation: conversation.clone(),
            runtime: initial_runtime.clone(),
            binding: Some(binding.clone()),
            task_run: None,
            config_options: handle.config_options.clone(),
            models: handle.models.clone(),
            modes: handle.modes.clone(),
            available_commands: Vec::new(),
            pending_permissions: Vec::new(),
        };
        self.db.create_conversation_atomic(
            &conversation,
            &binding,
            "ConversationCreated",
            &json!({ "origin": "oneagent_managed" }),
            &serde_json::to_value(RuntimeSnapshotState::from_conversation_state(
                &initial_state,
            ))
            .unwrap_or_else(|_| json!({})),
        )?;
        self.session_manager
            .insert(conversation.id.clone(), managed_session);
        self.set_runtime_state(&conversation.id, initial_runtime)?;
        // Process startup events (e.g. available_commands_update) that
        // arrived immediately after session creation.
        for event in startup_events {
            let _ = self.apply_stream_event(&conversation.id, "startup", event);
        }
        let state = ConversationState {
            conversation: self.db.get_conversation(&conversation.id)?,
            runtime: self.runtime_state(&conversation.id),
            binding: Some(binding),
            task_run: None,
            config_options: handle.config_options.clone(),
            models: handle.models.clone(),
            modes: handle.modes.clone(),
            available_commands: self.conversation_available_commands(&conversation.id),
            pending_permissions: Vec::new(),
        };
        self.db.replace_snapshot(
            &conversation.id,
            1,
            &serde_json::to_value(RuntimeSnapshotState::from_conversation_state(&state))
                .unwrap_or_else(|_| json!({})),
            state.conversation.last_event_seq,
        )?;
        self.emit_conversation_state(&conversation.id)?;
        Ok(state)
    }

    pub async fn preview_session_config(
        &self,
        input: PreviewSessionConfigInput,
    ) -> RuntimeResult<PreviewSessionConfigResult> {
        let workspace = self.db.get_workspace(&input.workspace_id)?;
        let profile = self.db.get_agent_profile(&input.agent_profile_id)?;
        let mcp_servers = self.mcp_registry.list_for_workspace(&workspace.id)?;
        match profile.kind {
            AgentKind::Acp => {
                let (session, _events) =
                    AcpLiveSession::start_new(&profile, &workspace.cwd, &mcp_servers).await?;
                let result = PreviewSessionConfigResult {
                    config_options: session.handle.config_options.clone(),
                    models: session.handle.models.clone(),
                    modes: session.handle.modes.clone(),
                };
                session.close();
                Ok(result)
            }
            AgentKind::Compat => {
                let handle = self
                    .adapter_for(&profile)
                    .new_session(&profile, &workspace.cwd, &mcp_servers)
                    .await?;
                let result = PreviewSessionConfigResult {
                    config_options: handle.config_options.clone(),
                    models: handle.models.clone(),
                    modes: handle.modes.clone(),
                };
                self.adapter_for(&profile).close(&profile, &handle).await?;
                Ok(result)
            }
        }
    }

    pub async fn import_conversation(
        &self,
        workspace_id: &str,
        agent_profile_id: &str,
        remote_session_id: &str,
    ) -> RuntimeResult<ConversationState> {
        let workspace = self.db.get_workspace(workspace_id)?;
        let profile = self.db.get_agent_profile(agent_profile_id)?;
        let mcp_servers = self.mcp_registry.list_for_workspace(&workspace.id)?;
        let now = Utc::now();
        let conversation = Conversation {
            id: Uuid::new_v4().to_string(),
            workspace_id: workspace.id.clone(),
            agent_profile_id: profile.id.clone(),
            origin: ConversationOrigin::Imported,
            status: ConversationStatus::Initializing,
            title: format!("Imported {remote_session_id}"),
            created_at: now,
            updated_at: now,
            last_event_seq: 0,
            source: "oneagent".to_string(),
            channel_chat_id: None,
        };
        let (loaded, managed_session) = match profile.kind {
            AgentKind::Acp => {
                let (session, replay_events) = AcpLiveSession::start_loaded(
                    &profile,
                    remote_session_id,
                    &workspace.cwd,
                    &mcp_servers,
                )
                .await?;
                (
                    LoadedSession {
                        handle: session.handle.clone(),
                        replay_events,
                    },
                    Some(ManagedSession::Acp(session)),
                )
            }
            AgentKind::Compat => (
                self.adapter_for(&profile)
                    .load_session(&profile, remote_session_id, &workspace.cwd, &mcp_servers)
                    .await?,
                None,
            ),
        };
        let binding = AgentSessionBinding {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation.id.clone(),
            adapter_kind: profile.kind.clone(),
            remote_session_id: remote_session_id.to_string(),
            cwd: workspace.cwd.clone(),
            load_supported: loaded.handle.load_supported,
            source: AgentSessionSource::Imported,
            last_synced_at: Utc::now(),
        };
        let initial_runtime = ConversationRuntimeState {
            connection_phase: ConnectionPhase::Ready,
            session_phase: SessionPhase::Hot,
            turn_phase: TurnPhase::Idle,
            last_error: None,
            last_transition_at: Utc::now(),
        };
        let initial_state = ConversationState {
            conversation: conversation.clone(),
            runtime: initial_runtime.clone(),
            binding: Some(binding.clone()),
            task_run: None,
            config_options: loaded.handle.config_options.clone(),
            models: loaded.handle.models.clone(),
            modes: loaded.handle.modes.clone(),
            available_commands: Vec::new(),
            pending_permissions: Vec::new(),
        };
        self.db.create_conversation_atomic(
            &conversation,
            &binding,
            "ConversationImported",
            &json!({ "remote_session_id": remote_session_id }),
            &serde_json::to_value(RuntimeSnapshotState::from_conversation_state(
                &initial_state,
            ))
            .unwrap_or_else(|_| json!({})),
        )?;
        if let Some(session) = managed_session {
            self.session_manager
                .insert(conversation.id.clone(), session);
        }
        if !self.session_manager.is_session_in_memory(&conversation.id) {
            self.session_manager.insert(
                conversation.id.clone(),
                ManagedSession::Passive(loaded.handle.clone()),
            );
        }

        let mut messages = Vec::new();
        let mut tool_calls = Vec::new();
        let mut terminals = Vec::new();
        let mut events = Vec::new();
        let mut replay_turn_id = uuid::Uuid::new_v4().to_string();
        let mut replay_turn_index = 0_u64;

        for event in &loaded.replay_events {
            match event {
                RuntimeStreamEvent::MessageChunk { role, .. }
                | RuntimeStreamEvent::MessageComplete { role, .. }
                    if role == "user" =>
                {
                    replay_turn_index += 1;
                    replay_turn_id = format!("history-{replay_turn_index}");
                }
                RuntimeStreamEvent::TurnFinished { .. } => {}
                _ if replay_turn_index == 0 => {
                    replay_turn_index = 1;
                    replay_turn_id = "history-1".to_string();
                }
                _ => {}
            }

            match event {
                RuntimeStreamEvent::MessageComplete { role, content, .. } => {
                    messages.push(crate::domain::MessageProjection {
                        id: uuid::Uuid::new_v4().to_string(),
                        conversation_id: conversation.id.clone(),
                        turn_id: replay_turn_id.clone(),
                        role: Self::role_from_stream(role),
                        kind: crate::domain::MessageKind::Text,
                        content_json: serde_json::json!({ "text": content, "stream": false }),
                        created_at: Utc::now(),
                    });
                }
                RuntimeStreamEvent::ToolCall {
                    tool_call_id,
                    title,
                    kind,
                    status,
                    raw_input,
                    raw_output,
                    content,
                    diffs,
                    terminal_ids,
                    locations,
                    ..
                } => {
                    tool_calls.push(crate::domain::ToolCallProjection {
                        id: tool_call_id.clone(),
                        conversation_id: conversation.id.clone(),
                        turn_id: replay_turn_id.clone(),
                        tool_call_id: tool_call_id.clone(),
                        title: title.clone(),
                        kind: kind.clone(),
                        status: status.clone(),
                        raw_input_json: raw_input.clone(),
                        raw_output_json: raw_output.clone(),
                        content_json: serde_json::json!({ "elements": content }),
                        diffs_json: serde_json::json!(diffs),
                        terminal_ids_json: serde_json::json!(terminal_ids),
                        locations_json: serde_json::json!(locations),
                        started_at: Some(Utc::now()),
                        ended_at: matches!(status, crate::domain::ToolCallStatus::Completed | crate::domain::ToolCallStatus::Failed | crate::domain::ToolCallStatus::Cancelled)
                            .then_some(Utc::now()),
                    });
                }
                RuntimeStreamEvent::TerminalEvent {
                    terminal_id,
                    event,
                    cwd,
                    command,
                    args,
                    stream: _,
                    content: _,
                    exit_code: _,
                    ..
                } => {
                    if event == "started" {
                        terminals.push(crate::domain::TerminalRecord {
                            id: terminal_id.clone(),
                            conversation_id: conversation.id.clone(),
                            turn_id: replay_turn_id.clone(),
                            terminal_id: terminal_id.clone(),
                            cwd: cwd.clone().unwrap_or_default(),
                            command: command.clone().unwrap_or_default(),
                            args_json: serde_json::json!(args),
                            status: crate::domain::TerminalStatus::Running,
                            stdout_buffer: String::new(),
                            stderr_buffer: String::new(),
                            started_at: Utc::now(),
                            ended_at: None,
                        });
                    }
                }
                RuntimeStreamEvent::Error { message } => {
                    messages.push(crate::domain::MessageProjection {
                        id: uuid::Uuid::new_v4().to_string(),
                        conversation_id: conversation.id.clone(),
                        turn_id: replay_turn_id.clone(),
                        role: crate::domain::MessageRole::System,
                        kind: crate::domain::MessageKind::Error,
                        content_json: serde_json::json!({ "message": message }),
                        created_at: Utc::now(),
                    });
                }
                _ => {}
            }
        }

        events.push(crate::domain::RuntimeEvent {
            seq: 0,
            conversation_id: conversation.id.clone(),
            event_type: "ConversationImported".to_string(),
            payload_json: serde_json::json!({ "remote_session_id": remote_session_id }),
            created_at: Utc::now(),
        });
        events.push(crate::domain::RuntimeEvent {
            seq: 0,
            conversation_id: conversation.id.clone(),
            event_type: "ConversationReplayCompleted".to_string(),
            payload_json: serde_json::json!({ "replayed_events": loaded.replay_events.len() }),
            created_at: Utc::now(),
        });

        let snapshot_state = serde_json::to_value(RuntimeSnapshotState::from_conversation_state(
            &initial_state,
        ))
        .unwrap_or_else(|_| serde_json::json!({}));

        self.db.import_conversation_atomic(
            &conversation,
            &binding,
            &messages,
            &tool_calls,
            &terminals,
            &events,
            &snapshot_state,
        )?;

        self.set_runtime_state(
            &conversation.id,
            ConversationRuntimeState {
                connection_phase: ConnectionPhase::Ready,
                session_phase: SessionPhase::Hot,
                turn_phase: TurnPhase::Idle,
                last_error: None,
                last_transition_at: Utc::now(),
            },
        )?;
        let state = ConversationState {
            conversation: self.db.get_conversation(&conversation.id)?,
            runtime: self.runtime_state(&conversation.id),
            binding: Some(binding),
            task_run: None,
            config_options: loaded.handle.config_options.clone(),
            models: loaded.handle.models.clone(),
            modes: loaded.handle.modes.clone(),
            available_commands: Vec::new(),
            pending_permissions: self.db.list_pending_permissions(&conversation.id)?,
        };
        self.db.replace_snapshot(
            &conversation.id,
            1,
            &serde_json::to_value(RuntimeSnapshotState::from_conversation_state(&state))
                .unwrap_or_else(|_| json!({})),
            state.conversation.last_event_seq,
        )?;
        self.emit_conversation_state(&conversation.id)?;
        Ok(state)
    }

    pub async fn create_task_run(
        &self,
        input: CreateTaskRunInput,
    ) -> RuntimeResult<ConversationState> {
        let workspace = self.db.get_workspace(&input.workspace_id)?;
        let profile = self.db.get_agent_profile(&input.agent_profile_id)?;
        let mcp_servers = self.mcp_registry.list_for_workspace(&workspace.id)?;
        let (managed_session, startup_events) = match profile.kind {
            AgentKind::Acp => {
                let (session, events) =
                    AcpLiveSession::start_new(&profile, &workspace.cwd, &mcp_servers).await?;
                (ManagedSession::Acp(session), events)
            }
            AgentKind::Compat => (
                ManagedSession::Passive(
                    self.adapter_for(&profile)
                        .new_session(&profile, &workspace.cwd, &mcp_servers)
                        .await?,
                ),
                Vec::new(),
            ),
        };
        let handle = match &managed_session {
            ManagedSession::Acp(session) => session.handle.clone(),
            ManagedSession::Passive(handle) => handle.clone(),
        };
        let now = Utc::now();
        let conversation = Conversation {
            id: Uuid::new_v4().to_string(),
            workspace_id: workspace.id.clone(),
            agent_profile_id: profile.id.clone(),
            origin: ConversationOrigin::WorkerTask,
            status: ConversationStatus::Initializing,
            title: input
                .title
                .unwrap_or_else(|| input.goal.chars().take(40).collect()),
            created_at: now,
            updated_at: now,
            last_event_seq: 0,
            source: "oneagent".to_string(),
            channel_chat_id: None,
        };
        let task = TaskRun {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation.id.clone(),
            workspace_id: workspace.id.clone(),
            agent_profile_id: profile.id.clone(),
            goal: input.goal.clone(),
            status: TaskRunStatus::Pending,
            result_summary: None,
            created_at: now,
            updated_at: now,
        };
        let binding = AgentSessionBinding {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation.id.clone(),
            adapter_kind: profile.kind.clone(),
            remote_session_id: handle.remote_session_id.clone(),
            cwd: handle.cwd.clone(),
            load_supported: handle.load_supported,
            source: AgentSessionSource::New,
            last_synced_at: Utc::now(),
        };
        let initial_runtime = ConversationRuntimeState {
            connection_phase: ConnectionPhase::Ready,
            session_phase: SessionPhase::Hot,
            turn_phase: TurnPhase::Idle,
            last_error: None,
            last_transition_at: Utc::now(),
        };
        let initial_state = ConversationState {
            conversation: conversation.clone(),
            runtime: initial_runtime.clone(),
            binding: Some(binding.clone()),
            task_run: Some(task.clone()),
            config_options: handle.config_options.clone(),
            models: handle.models.clone(),
            modes: handle.modes.clone(),
            available_commands: Vec::new(),
            pending_permissions: Vec::new(),
        };
        self.db.create_task_run_atomic(
            &conversation,
            &task,
            &binding,
            "TaskRunCreated",
            &json!({ "goal": input.goal }),
            &serde_json::to_value(RuntimeSnapshotState::from_conversation_state(
                &initial_state,
            ))
            .unwrap_or_else(|_| json!({})),
        )?;
        self.session_manager
            .insert(conversation.id.clone(), managed_session);
        self.set_runtime_state(&conversation.id, initial_runtime)?;
        // Process startup events (e.g. available_commands_update).
        for event in startup_events {
            let _ = self.apply_stream_event(&conversation.id, "startup", event);
        }
        let state = ConversationState {
            conversation: self.db.get_conversation(&conversation.id)?,
            runtime: self.runtime_state(&conversation.id),
            binding: Some(binding),
            task_run: self.db.get_task_run(&conversation.id)?,
            config_options: handle.config_options.clone(),
            models: handle.models.clone(),
            modes: handle.modes.clone(),
            available_commands: self.conversation_available_commands(&conversation.id),
            pending_permissions: Vec::new(),
        };
        self.db.replace_snapshot(
            &conversation.id,
            1,
            &serde_json::to_value(RuntimeSnapshotState::from_conversation_state(&state))
                .unwrap_or_else(|_| json!({})),
            state.conversation.last_event_seq,
        )?;
        self.emit_task_run_state(&conversation.id)?;
        Ok(state)
    }

    pub async fn send_user_message(
        &self,
        conversation_id: &str,
        text: &str,
        attachments: Vec<AttachmentInput>,
    ) -> RuntimeResult<TimelineResponse> {
        let conversation = self.db.get_conversation(conversation_id)?;
        let current_runtime = self.runtime_state(conversation_id);
        if matches!(
            current_runtime.turn_phase,
            TurnPhase::Running | TurnPhase::Cancelling
        ) {
            return Err(RuntimeError::InvalidState(
                "conversation already has an active turn".to_string(),
            ));
        }
        let profile = self.db.get_agent_profile(&conversation.agent_profile_id)?;
        let binding = self.db.get_binding(conversation_id)?.ok_or_else(|| {
            RuntimeError::InvalidState("conversation is missing agent session binding".to_string())
        })?;

        let is_hot = self.is_session_in_memory(conversation_id);
        self.update_runtime_state(conversation_id, |runtime| {
            runtime.last_error = None;
            // Set Running *before* spawning the turn task so the frontend's
            // first poll already sees an active turn state instead of Idle.
            runtime.turn_phase = TurnPhase::Running;
            if is_hot {
                runtime.connection_phase = ConnectionPhase::Ready;
                runtime.session_phase = SessionPhase::Hot;
            } else {
                runtime.connection_phase = ConnectionPhase::Disconnected;
                runtime.session_phase = SessionPhase::Loading;
            }
        })?;
        let turn_id = Uuid::new_v4().to_string();
        self.record_lifecycle_event(
            conversation_id,
            "TurnStarted",
            json!({ "turn_id": turn_id }),
        )?;
        let user_message = MessageProjection {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            turn_id: turn_id.clone(),
            role: MessageRole::User,
            kind: MessageKind::Text,
            content_json: json!({
                "text": text,
                "attachments": attachments
            }),
            created_at: Utc::now(),
        };
        self.db.upsert_message(&user_message)?;
        self.record_lifecycle_event(
            conversation_id,
            "UserMessageAccepted",
            serde_json::to_value(&user_message).unwrap_or_else(|_| json!({})),
        )?;
        self.emit(
            "conversation:message_appended",
            &json!({ "conversation_id": conversation_id, "message": user_message }),
        );
        self.emit_conversation_state(conversation_id)?;
        let timeline = self.timeline(conversation_id)?;

        let runtime = self.clone();
        let conversation_id = conversation_id.to_string();
        let turn_id_for_task = turn_id.clone();
        let text = text.to_string();
        tokio::spawn(async move {
            if let Err(error) = runtime
                .run_turn_task(
                    conversation_id.clone(),
                    turn_id_for_task,
                    profile,
                    binding,
                    text,
                    attachments,
                )
                .await
            {
                let _ = runtime
                    .handle_turn_task_error(&conversation_id, &error)
                    .await;
            }
        });

        Ok(timeline)
    }

    async fn run_turn_task(
        &self,
        conversation_id: String,
        turn_id: String,
        profile: AgentProfile,
        binding: AgentSessionBinding,
        text: String,
        attachments: Vec<AttachmentInput>,
    ) -> RuntimeResult<()> {
        // Emit Recovering while attempting to restore the session so the
        // frontend can display the recovery phase before Running.
        let was_cold = !self.is_session_in_memory(&conversation_id);
        if was_cold {
            self.update_runtime_state(&conversation_id, |runtime| {
                runtime.connection_phase = ConnectionPhase::Disconnected;
                runtime.session_phase = SessionPhase::Loading;
                runtime.turn_phase = TurnPhase::Running;
                runtime.last_error = None;
            })?;
            self.emit_conversation_state(&conversation_id)?;
        }

        let session = self
            .ensure_live_session(&conversation_id, &profile, &binding)
            .await?;
        let keep_hot_session = matches!(session, ManagedSession::Acp(_));
        self.update_runtime_state(&conversation_id, |runtime| {
            runtime.connection_phase = ConnectionPhase::Ready;
            runtime.session_phase = SessionPhase::Hot;
            runtime.turn_phase = TurnPhase::Running;
            runtime.last_error = None;
        })?;
        self.emit_conversation_state(&conversation_id)?;

        match session {
            ManagedSession::Acp(ref session) if was_cold => {
                // For freshly-recovered sessions, the agent's internal model
                // resets to its default.  Re-apply the stored model selection
                // so the turn actually runs on the user's chosen model.
                let stored_model = self
                    .conversation_config_options(&conversation_id)
                    .into_iter()
                    .find(|o| o.category.as_deref() == Some("model"))
                    .and_then(|o| o.current_value.as_str().map(ToOwned::to_owned));
                if let Some(model_id) = stored_model {
                    let _ = session.set_model(&model_id).await;
                }
            }
            _ => {}
        }

        match session {
            ManagedSession::Acp(session) => {
                let (mut event_rx, mut completion_rx) =
                    session.run_turn(&text, &attachments).await?;
                loop {
                    tokio::select! {
                        maybe_event = event_rx.recv() => {
                            if let Some(event) = maybe_event {
                                self.apply_stream_event(&conversation_id, &turn_id, event)?;
                            }
                        }
                        result = &mut completion_rx => {
                            result.map_err(|_| RuntimeError::InvalidState("prompt completion channel dropped".to_string()))??;
                            while let Ok(event) = event_rx.try_recv() {
                                self.apply_stream_event(&conversation_id, &turn_id, event)?;
                            }
                            break;
                        }
                    }
                }
            }
            ManagedSession::Passive(handle) => {
                let stream = self
                    .adapter_for(&profile)
                    .prompt(&profile, &handle, &text, &attachments)
                    .await?;
                for event in stream {
                    self.apply_stream_event(&conversation_id, &turn_id, event)?;
                }
            }
        }

        let is_hot_now = keep_hot_session || self.is_session_in_memory(&conversation_id);
        self.update_runtime_state(&conversation_id, |runtime| {
            runtime.connection_phase = if is_hot_now {
                ConnectionPhase::Ready
            } else {
                ConnectionPhase::Disconnected
            };
            runtime.session_phase = if is_hot_now {
                SessionPhase::Hot
            } else {
                SessionPhase::Cold
            };
            runtime.turn_phase = TurnPhase::Idle;
        })?;
        let state = self.conversation_state(&conversation_id)?;
        self.db.replace_snapshot(
            &conversation_id,
            1,
            &serde_json::to_value(RuntimeSnapshotState::from_conversation_state(&state))
                .unwrap_or_else(|_| json!({})),
            self.db.get_conversation(&conversation_id)?.last_event_seq,
        )?;
        if let Some(task_run) = self.db.get_task_run(&conversation_id)? {
            let status = self.db.get_conversation(&conversation_id)?.status;
            let summary = self.summarize_task_from_storage(&conversation_id, &status)?;
            self.db.update_task_run(
                &task_run.conversation_id,
                TaskRunStatus::Completed,
                summary.as_deref(),
            )?;
            self.emit(
                "task_run:state_changed",
                &json!({ "conversation_id": task_run.conversation_id, "task_run": self.db.get_task_run(&task_run.conversation_id)? }),
            );
        }
        self.emit_conversation_state(&conversation_id)?;
        Ok(())
    }

    async fn handle_turn_task_error(
        &self,
        conversation_id: &str,
        error: &RuntimeError,
    ) -> RuntimeResult<()> {
        let is_hot = self.is_session_in_memory(conversation_id);
        self.update_runtime_state(conversation_id, |runtime| {
            runtime.connection_phase = if is_hot {
                ConnectionPhase::Ready
            } else {
                ConnectionPhase::Disconnected
            };
            runtime.session_phase = if is_hot {
                SessionPhase::Hot
            } else {
                SessionPhase::Cold
            };
            runtime.turn_phase = TurnPhase::Failed;
            runtime.last_error = Some(error.to_string());
        })?;
        let message = MessageProjection {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            turn_id: Uuid::new_v4().to_string(),
            role: MessageRole::System,
            kind: MessageKind::Error,
            content_json: json!({ "message": error.to_string() }),
            created_at: Utc::now(),
        };
        self.db.upsert_message(&message)?;
        self.emit(
            "conversation:message_appended",
            &json!({ "conversation_id": conversation_id, "message": message }),
        );
        self.emit_conversation_state(conversation_id)?;
        Ok(())
    }

    pub async fn cancel_turn(&self, conversation_id: &str) -> RuntimeResult<()> {
        let conversation = self.db.get_conversation(conversation_id)?;
        let profile = self.db.get_agent_profile(&conversation.agent_profile_id)?;
        let binding = self
            .db
            .get_binding(conversation_id)?
            .ok_or_else(|| RuntimeError::InvalidState("missing binding".to_string()))?;

        match self.session_runtime(conversation_id, binding.clone())? {
            ManagedSession::Acp(session) => session.cancel().await?,
            ManagedSession::Passive(handle) => {
                self.adapter_for(&profile).cancel(&profile, &handle).await?;
            }
        }
        let prefix = format!("{conversation_id}:");
        self.streaming_messages
            .lock()
            .retain(|key, _| !key.starts_with(&prefix));
        self.terminal_records_cache
            .lock()
            .retain(|key, _| !key.starts_with(&prefix));

        let is_hot = self.is_session_in_memory(conversation_id);
        let mut runtime = self.runtime_state(conversation_id);
        runtime.connection_phase = if is_hot {
            ConnectionPhase::Ready
        } else {
            ConnectionPhase::Disconnected
        };
        runtime.session_phase = if is_hot {
            SessionPhase::Hot
        } else {
            SessionPhase::Cold
        };
        runtime.turn_phase = TurnPhase::Idle;
        runtime.last_error = None;
        let final_status = Self::derive_display_status(&runtime);

        if let Some(task_run) = self.db.cancel_turn_atomic(conversation_id, &final_status)? {
            self.emit(
                "task_run:state_changed",
                &json!({ "conversation_id": conversation_id, "task_run": task_run }),
            );
        }

        self.set_runtime_state(conversation_id, runtime)?;
        self.emit(
            "conversation:turn_finished",
            &json!({ "conversation_id": conversation_id, "turn_id": serde_json::Value::Null, "status": "cancelled" }),
        );
        self.emit_conversation_state(conversation_id)?;
        Ok(())
    }

    pub async fn delete_conversation(&self, conversation_id: &str) -> RuntimeResult<()> {
        let conversation = self.db.get_conversation(conversation_id)?;
        let managed_session = self.session_manager.remove(conversation_id);
        self.runtime_states.lock().remove(conversation_id);
        let prefix = format!("{conversation_id}:");
        self.terminal_records_cache
            .lock()
            .retain(|key, _| !key.starts_with(&prefix));
        if let Some(binding) = self.db.get_binding(conversation_id)? {
            let profile = self.db.get_agent_profile(&conversation.agent_profile_id)?;
            match managed_session {
                Some(ManagedSession::Acp(session)) => {
                    session.close();
                }
                Some(ManagedSession::Passive(handle)) => {
                    self.adapter_for(&profile).close(&profile, &handle).await?;
                }
                None => {
                    let fallback_handle = AgentSessionHandle {
                        adapter_kind: enum_text(&binding.adapter_kind),
                        remote_session_id: binding.remote_session_id,
                        cwd: binding.cwd,
                        load_supported: binding.load_supported,
                        prompt_capabilities: self
                            .conversation_prompt_capabilities(conversation_id)
                            .unwrap_or(AgentPromptCapabilities {
                                text: true,
                                resource_link: false,
                                embedded_context: false,
                                image: false,
                                audio: false,
                            }),
                        config_options: self
                            .conversation_state(conversation_id)
                            .ok()
                            .map(|state| state.config_options)
                            .unwrap_or_default(),
                        models: self.conversation_models(conversation_id),
                        modes: self.conversation_modes(conversation_id),
                    };
                    self.adapter_for(&profile)
                        .close(&profile, &fallback_handle)
                        .await?;
                }
            }
        }
        let prefix = format!("{conversation_id}:");
        self.streaming_messages
            .lock()
            .retain(|key, _| !key.starts_with(&prefix));
        self.db.delete_conversation(conversation_id)?;
        self.emit(
            "conversation:deleted",
            &json!({ "conversation_id": conversation_id }),
        );
        Ok(())
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
            .ok_or_else(|| RuntimeError::InvalidState("missing binding".to_string()))?;
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
            .ok_or_else(|| RuntimeError::InvalidState("missing binding".to_string()))?;
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
            .ok_or_else(|| RuntimeError::InvalidState("missing binding".to_string()))?;
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
            .ok_or_else(|| {
                RuntimeError::InvalidState("pending permission request not found".to_string())
            })?;
        if pending.status != PendingPermissionStatus::Pending {
            return Err(RuntimeError::InvalidState(
                "permission request is no longer pending".to_string(),
            ));
        }
        if pending.fingerprint != fingerprint {
            return Err(RuntimeError::InvalidState(
                "permission fingerprint does not match latest pending request".to_string(),
            ));
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
        let mut snapshot_state = self.snapshot_state(conversation_id).unwrap_or_default();
        snapshot_state.config_options = config_options;
        let event_seq = self.db.get_conversation(conversation_id)?.last_event_seq;
        self.db.replace_snapshot(
            conversation_id,
            1,
            &serde_json::to_value(&snapshot_state).unwrap_or_else(|_| Value::Null),
            event_seq,
        )?;
        Ok(())
    }

    fn update_snapshot_models(
        &self,
        conversation_id: &str,
        models: AcpSessionModels,
    ) -> RuntimeResult<()> {
        let mut snapshot_state = self.snapshot_state(conversation_id).unwrap_or_default();
        snapshot_state.models = Some(models);
        let event_seq = self.db.get_conversation(conversation_id)?.last_event_seq;
        self.db.replace_snapshot(
            conversation_id,
            1,
            &serde_json::to_value(&snapshot_state).unwrap_or_else(|_| Value::Null),
            event_seq,
        )?;
        Ok(())
    }

    fn update_snapshot_modes(
        &self,
        conversation_id: &str,
        modes: AcpSessionModeState,
    ) -> RuntimeResult<()> {
        let mut snapshot_state = self.snapshot_state(conversation_id).unwrap_or_default();
        snapshot_state.modes = Some(modes);
        let event_seq = self.db.get_conversation(conversation_id)?.last_event_seq;
        self.db.replace_snapshot(
            conversation_id,
            1,
            &serde_json::to_value(&snapshot_state).unwrap_or_else(|_| Value::Null),
            event_seq,
        )?;
        Ok(())
    }

    fn update_snapshot_available_commands(
        &self,
        conversation_id: &str,
        available_commands: Vec<AvailableCommand>,
    ) -> RuntimeResult<()> {
        let mut snapshot_state = self.snapshot_state(conversation_id).unwrap_or_default();
        snapshot_state.available_commands = available_commands;
        let event_seq = self.db.get_conversation(conversation_id)?.last_event_seq;
        self.db.replace_snapshot(
            conversation_id,
            1,
            &serde_json::to_value(&snapshot_state).unwrap_or_else(|_| Value::Null),
            event_seq,
        )?;
        Ok(())
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

#[cfg(test)]
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

#[cfg(not(test))]
#[allow(dead_code)]
fn summarize_task_timeline(
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
