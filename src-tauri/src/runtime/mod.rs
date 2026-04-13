use std::{collections::HashMap, sync::Arc};

use chrono::{DateTime, Utc};
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
    storage::{Database, StorageResult},
};

#[derive(thiserror::Error, Debug)]
pub enum RuntimeError {
    #[error("storage error: {0}")]
    Storage(#[from] crate::storage::StorageError),
    #[error("adapter error: {0}")]
    Adapter(#[from] crate::agent_adapters::AdapterError),
    #[error("invalid state: {0}")]
    InvalidState(String),
}

pub type RuntimeResult<T> = Result<T, RuntimeError>;

#[derive(Clone)]
pub struct Runtime {
    db: Database,
    mcp_registry: McpRegistry,
    skill_registry: SkillRegistry,
    policy_engine: PolicyEngine,
    emitter: Arc<Mutex<Option<EventEmitter>>>,
    sessions: Arc<Mutex<HashMap<String, ManagedSession>>>,
    runtime_states: Arc<Mutex<HashMap<String, ConversationRuntimeState>>>,
    streaming_messages: Arc<Mutex<HashMap<String, ActiveStreamMessage>>>,
}

pub type EventEmitter = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

#[derive(Clone)]
enum ManagedSession {
    Acp(AcpLiveSession),
    Passive(AgentSessionHandle),
}

#[derive(Clone)]
struct ActiveStreamMessage {
    id: String,
    role: MessageRole,
    kind: MessageKind,
    content: String,
    started_at: DateTime<Utc>,
}

impl Runtime {
    pub fn new(db: Database) -> Self {
        Self {
            mcp_registry: McpRegistry::new(db.clone()),
            skill_registry: SkillRegistry::new(db.clone()),
            policy_engine: PolicyEngine::new(db.clone()),
            db,
            emitter: Arc::new(Mutex::new(None)),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            runtime_states: Arc::new(Mutex::new(HashMap::new())),
            streaming_messages: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn attach_emitter(&self, emitter: EventEmitter) {
        *self.emitter.lock() = Some(emitter);
    }

    pub fn is_session_in_memory(&self, conversation_id: &str) -> bool {
        self.sessions.lock().contains_key(conversation_id)
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
                    ConnectionPhase::Disconnected | ConnectionPhase::Ready => ConversationStatus::Sleep,
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
        self.db.update_conversation_status(
            conversation_id,
            Self::derive_display_status(&runtime),
        )?;
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
        let conversation = self.db.create_conversation(
            &workspace.id,
            &profile.id,
            ConversationOrigin::OneagentManaged,
            input
                .title
                .unwrap_or_else(|| "New conversation".to_string()),
        )?;
        let managed_session = match profile.kind {
            AgentKind::Acp => ManagedSession::Acp(
                AcpLiveSession::start_new(&profile, &workspace.cwd, &mcp_servers).await?,
            ),
            AgentKind::Compat => ManagedSession::Passive(
                self.adapter_for(&profile)
                    .new_session(&profile, &workspace.cwd, &mcp_servers)
                    .await?,
            ),
        };
        let handle = match &managed_session {
            ManagedSession::Acp(session) => session.handle.clone(),
            ManagedSession::Passive(handle) => handle.clone(),
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
        self.db.upsert_binding(&binding)?;
        self.sessions
            .lock()
            .insert(conversation.id.clone(), managed_session);
        self.record_lifecycle_event(
            &conversation.id,
            "ConversationCreated",
            json!({ "origin": "oneagent_managed" }),
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
            config_options: handle.config_options.clone(),
            models: handle.models.clone(),
            modes: handle.modes.clone(),
            pending_permissions: Vec::new(),
        };
        self.db.replace_snapshot(
            &conversation.id,
            1,
            &serde_json::to_value(&state).unwrap_or_else(|_| json!({})),
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
                let session =
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
        let conversation = self.db.create_conversation(
            &workspace.id,
            &profile.id,
            ConversationOrigin::Imported,
            format!("Imported {remote_session_id}"),
        )?;
        let loaded = match profile.kind {
            AgentKind::Acp => {
                let (session, replay_events) = AcpLiveSession::start_loaded(
                    &profile,
                    remote_session_id,
                    &workspace.cwd,
                    &mcp_servers,
                )
                .await?;
                self.sessions.lock().insert(
                    conversation.id.clone(),
                    ManagedSession::Acp(session.clone()),
                );
                LoadedSession {
                    handle: session.handle.clone(),
                    replay_events,
                }
            }
            AgentKind::Compat => {
                self.adapter_for(&profile)
                    .load_session(&profile, remote_session_id, &workspace.cwd, &mcp_servers)
                    .await?
            }
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
        self.db.upsert_binding(&binding)?;
        if !self.sessions.lock().contains_key(&conversation.id) {
            self.sessions.lock().insert(
                conversation.id.clone(),
                ManagedSession::Passive(loaded.handle.clone()),
            );
        }
        self.record_lifecycle_event(
            &conversation.id,
            "ConversationImported",
            json!({ "remote_session_id": remote_session_id }),
        )?;
        self.apply_replay_events(&conversation.id, &loaded).await?;
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
            pending_permissions: self.db.list_pending_permissions(&conversation.id)?,
        };
        self.db.replace_snapshot(
            &conversation.id,
            1,
            &serde_json::to_value(&state).unwrap_or_else(|_| json!({})),
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
        let conversation = self.db.create_conversation(
            &workspace.id,
            &profile.id,
            ConversationOrigin::WorkerTask,
            input
                .title
                .unwrap_or_else(|| input.goal.chars().take(40).collect()),
        )?;
        let task =
            self.db
                .create_task_run(&conversation.id, &workspace.id, &profile.id, &input.goal)?;
        let managed_session = match profile.kind {
            AgentKind::Acp => ManagedSession::Acp(
                AcpLiveSession::start_new(&profile, &workspace.cwd, &mcp_servers).await?,
            ),
            AgentKind::Compat => ManagedSession::Passive(
                self.adapter_for(&profile)
                    .new_session(&profile, &workspace.cwd, &mcp_servers)
                    .await?,
            ),
        };
        let handle = match &managed_session {
            ManagedSession::Acp(session) => session.handle.clone(),
            ManagedSession::Passive(handle) => handle.clone(),
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
        self.db.upsert_binding(&binding)?;
        self.sessions
            .lock()
            .insert(conversation.id.clone(), managed_session);
        self.record_lifecycle_event(
            &conversation.id,
            "TaskRunCreated",
            json!({ "goal": input.goal }),
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
        self.db
            .update_task_run(&conversation.id, TaskRunStatus::Running, None)?;
        let state = ConversationState {
            conversation: self.db.get_conversation(&conversation.id)?,
            runtime: self.runtime_state(&conversation.id),
            binding: Some(binding),
            task_run: Some(task),
            config_options: handle.config_options.clone(),
            models: handle.models.clone(),
            modes: handle.modes.clone(),
            pending_permissions: Vec::new(),
        };
        self.db.replace_snapshot(
            &conversation.id,
            1,
            &serde_json::to_value(&state).unwrap_or_else(|_| json!({})),
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
        if matches!(current_runtime.turn_phase, TurnPhase::Running | TurnPhase::Cancelling) {
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
                                self.apply_stream_event(&conversation_id, &turn_id, event).await?;
                            }
                        }
                        result = &mut completion_rx => {
                            result.map_err(|_| RuntimeError::InvalidState("prompt completion channel dropped".to_string()))??;
                            while let Ok(event) = event_rx.try_recv() {
                                self.apply_stream_event(&conversation_id, &turn_id, event).await?;
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
                    self.apply_stream_event(&conversation_id, &turn_id, event)
                        .await?;
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
        let timeline = self.timeline(&conversation_id)?;
        let state = self.conversation_state(&conversation_id)?;
        self.db.replace_snapshot(
            &conversation_id,
            1,
            &serde_json::to_value(&state).unwrap_or_else(|_| json!({})),
            self.db.get_conversation(&conversation_id)?.last_event_seq,
        )?;
        if let Some(task_run) = self.db.get_task_run(&conversation_id)? {
            let status = self.db.get_conversation(&conversation_id)?.status;
            let summary = summarize_task_timeline(&timeline, &status);
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

    async fn ensure_live_session(
        &self,
        conversation_id: &str,
        profile: &AgentProfile,
        binding: &AgentSessionBinding,
    ) -> RuntimeResult<ManagedSession> {
        match self.session_runtime(conversation_id, binding.clone())? {
            ManagedSession::Acp(session) => Ok(ManagedSession::Acp(session)),
            ManagedSession::Passive(handle) => {
                if profile.kind != AgentKind::Acp {
                    return Ok(ManagedSession::Passive(handle));
                }

                // For ACP profiles we MUST establish a live session so that
                // streaming works.  Try loading first; fall back to a fresh
                // session if the agent does not support session/load.
                self.record_lifecycle_event(
                    conversation_id,
                    "ConversationRecoveryStarted",
                    json!({ "remote_session_id": handle.remote_session_id }),
                )?;
                let workspace_id = self.db.get_conversation(conversation_id)?.workspace_id;
                let workspace = self.db.get_workspace(&workspace_id)?;
                let mcp_servers = self.mcp_registry.list_for_workspace(&workspace.id)?;

                // Always attempt start_loaded first to preserve conversation
                // history.  If the agent rejects session/load, fall back to
                // start_new below.
                match AcpLiveSession::start_loaded(
                    profile,
                    &handle.remote_session_id,
                    &handle.cwd,
                    &mcp_servers,
                )
                .await
                {
                    Ok((session, replay_events)) => {
                        self.consume_replay_events_for_recovery(
                            conversation_id,
                            replay_events,
                        )?;
                        let managed = ManagedSession::Acp(session.clone());
                        self.sessions
                            .lock()
                            .insert(conversation_id.to_string(), managed.clone());
                        self.record_lifecycle_event(
                            conversation_id,
                            "ConversationRecoveryCompleted",
                            json!({ "remote_session_id": handle.remote_session_id }),
                        )?;
                        return Ok(managed);
                    }
                    Err(load_err) => {
                        eprintln!(
                            "[runtime] start_loaded failed for {}, falling back to start_new: {load_err}",
                            conversation_id,
                        );
                    }
                }

                // 2) Fallback: start a fresh live session.  The agent loses
                //    in-process history but we gain streaming + Connected.
                let session =
                    AcpLiveSession::start_new(profile, &handle.cwd, &mcp_servers).await?;
                // Update binding so the new session id is persisted for future
                // operations (cancel, set_config, etc.).
                let mut updated_binding = binding.clone();
                updated_binding.remote_session_id =
                    session.handle.remote_session_id.clone();
                updated_binding.load_supported = session.handle.load_supported;
                updated_binding.last_synced_at = Utc::now();
                let _ = self.db.upsert_binding(&updated_binding);
                let managed = ManagedSession::Acp(session.clone());
                self.sessions
                    .lock()
                    .insert(conversation_id.to_string(), managed.clone());
                self.record_lifecycle_event(
                    conversation_id,
                    "ConversationRecoveryFallbackNewSession",
                    json!({ "new_session_id": session.handle.remote_session_id }),
                )?;
                Ok(managed)
            }
        }
    }


    fn consume_replay_events_for_recovery(
        &self,
        conversation_id: &str,
        replay_events: Vec<RuntimeStreamEvent>,
    ) -> RuntimeResult<()> {
        let mut replay_count = 0_u64;
        let mut latest_config_options: Option<Vec<SessionConfigOption>> = None;

        for event in replay_events {
            replay_count += 1;
            if let RuntimeStreamEvent::ConfigOptionsUpdated { config_options } = event {
                latest_config_options = Some(config_options);
            }
        }

        if let Some(mut config_options) = latest_config_options {
            // The agent sends its OWN default model/mode as the currentValue in
            // the config_option_update during session/load replay.  We must NOT
            // let this overwrite the model/mode the user had previously chosen.
            // Restore the user's selections from the stored snapshot.
            let stored_opts = self.conversation_config_options(conversation_id);
            let stored_model = stored_opts
                .iter()
                .find(|o| o.category.as_deref() == Some("model"))
                .and_then(|o| o.current_value.as_str().map(ToOwned::to_owned));
            let stored_mode = stored_opts
                .iter()
                .find(|o| o.category.as_deref() == Some("mode"))
                .and_then(|o| o.current_value.as_str().map(ToOwned::to_owned));

            for option in &mut config_options {
                if option.category.as_deref() == Some("model") {
                    if let Some(ref model) = stored_model {
                        // Only restore if the stored model is still in the
                        // agent's available list (avoid ghost values).
                        let is_available = option
                            .options
                            .as_array()
                            .map(|arr| arr.iter().any(|o| o.get("value").and_then(Value::as_str) == Some(model.as_str())))
                            .unwrap_or(false);
                        if is_available {
                            option.current_value = Value::String(model.clone());
                        }
                    }
                }
                if option.category.as_deref() == Some("mode") {
                    if let Some(ref mode) = stored_mode {
                        let is_available = option
                            .options
                            .as_array()
                            .map(|arr| arr.iter().any(|o| o.get("value").and_then(Value::as_str) == Some(mode.as_str())))
                            .unwrap_or(false);
                        if is_available {
                            option.current_value = Value::String(mode.clone());
                        }
                    }
                }
            }

            self.update_snapshot_config_options(conversation_id, config_options)?;
        }

        self.record_lifecycle_event(
            conversation_id,
            "ConversationReplayConsumedDuringRecovery",
            json!({ "replayed_events": replay_count }),
        )?;
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
        let is_hot_before_cancel = self.is_session_in_memory(conversation_id);
        self.update_runtime_state(conversation_id, |runtime| {
            runtime.connection_phase = if is_hot_before_cancel {
                ConnectionPhase::Ready
            } else {
                ConnectionPhase::Disconnected
            };
            runtime.session_phase = if is_hot_before_cancel {
                SessionPhase::Hot
            } else {
                SessionPhase::Cold
            };
            runtime.turn_phase = TurnPhase::Cancelling;
            runtime.last_error = None;
        })?;
        self.emit_conversation_state(conversation_id)?;
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
        self.db
            .cancel_pending_permissions_for_turn(conversation_id)?;
        if self.db.get_task_run(conversation_id)?.is_some() {
            self.db.update_task_run(
                conversation_id,
                TaskRunStatus::Cancelled,
                Some("cancelled"),
            )?;
            self.emit(
                "task_run:state_changed",
                &json!({ "conversation_id": conversation_id, "task_run": self.db.get_task_run(conversation_id)? }),
            );
        }
        self.update_runtime_state(conversation_id, |runtime| {
            let is_hot = self.is_session_in_memory(conversation_id);
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
        })?;
        self.record_lifecycle_event(conversation_id, "TurnCancelled", json!({}))?;
        self.emit(
            "conversation:turn_finished",
            &json!({ "conversation_id": conversation_id, "turn_id": serde_json::Value::Null, "status": "cancelled" }),
        );
        self.emit_conversation_state(conversation_id)?;
        Ok(())
    }

    pub async fn delete_conversation(&self, conversation_id: &str) -> RuntimeResult<()> {
        let conversation = self.db.get_conversation(conversation_id)?;
        let managed_session = self.sessions.lock().remove(conversation_id);
        self.runtime_states.lock().remove(conversation_id);
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
                                resource_link: true,
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
        let record = self.policy_engine.record_decision(
            conversation_id,
            tool_call_id,
            fingerprint,
            decision,
        )?;
        let managed_session = { self.sessions.lock().get(conversation_id).cloned() };
        if let Some(ManagedSession::Acp(session)) = managed_session {
            session
                .resolve_permission(tool_call_id, record.decision.clone())
                .await?;
        }
        self.db
            .update_pending_permission_status(&pending.id, PendingPermissionStatus::Resolved)?;
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
        Ok(self
            .sessions
            .lock()
            .get(conversation_id)
            .cloned()
            .unwrap_or(ManagedSession::Passive(AgentSessionHandle {
                adapter_kind: enum_text(&fallback.adapter_kind),
                remote_session_id: fallback.remote_session_id,
                cwd: fallback.cwd,
                load_supported: fallback.load_supported,
                prompt_capabilities: self
                    .conversation_prompt_capabilities(conversation_id)
                    .unwrap_or(AgentPromptCapabilities {
                        text: true,
                        resource_link: true,
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
            })))
    }

    fn emit<S: serde::Serialize>(&self, event: &str, payload: &S) {
        if let Some(emitter) = self.emitter.lock().clone() {
            let value = serde_json::to_value(payload).unwrap_or_else(|_| json!({}));
            emitter(event, value);
        }
    }

    fn stream_message_key(
        conversation_id: &str,
        turn_id: &str,
        role: &MessageRole,
        kind: &MessageKind,
    ) -> String {
        format!(
            "{conversation_id}:{turn_id}:{}:{}",
            enum_text(role),
            enum_text(kind)
        )
    }

    fn role_from_stream(role: &str) -> MessageRole {
        if role == "agent" {
            MessageRole::Agent
        } else if role == "user" {
            MessageRole::User
        } else {
            MessageRole::System
        }
    }

    fn record_lifecycle_event(
        &self,
        conversation_id: &str,
        event_type: &str,
        payload: serde_json::Value,
    ) -> StorageResult<()> {
        self.db
            .append_event(conversation_id, event_type, &payload)?;
        Ok(())
    }

    fn conversation_config_options(&self, conversation_id: &str) -> Vec<SessionConfigOption> {
        self.db
            .get_snapshot(conversation_id)
            .ok()
            .flatten()
            .and_then(|snapshot| {
                serde_json::from_value::<ConversationState>(snapshot.state_json).ok()
            })
            .map(|state| state.config_options)
            .unwrap_or_default()
    }

    fn conversation_models(&self, conversation_id: &str) -> Option<AcpSessionModels> {
        self.db
            .get_snapshot(conversation_id)
            .ok()
            .flatten()
            .and_then(|snapshot| {
                serde_json::from_value::<ConversationState>(snapshot.state_json).ok()
            })
            .and_then(|state| state.models)
    }

    fn conversation_modes(&self, conversation_id: &str) -> Option<AcpSessionModeState> {
        self.db
            .get_snapshot(conversation_id)
            .ok()
            .flatten()
            .and_then(|snapshot| {
                serde_json::from_value::<ConversationState>(snapshot.state_json).ok()
            })
            .and_then(|state| state.modes)
    }

    fn finalize_thinking_stream(&self, conversation_id: &str, turn_id: &str) -> RuntimeResult<()> {
        let stream_key = Self::stream_message_key(
            conversation_id,
            turn_id,
            &MessageRole::System,
            &MessageKind::Thinking,
        );
        let active = self.streaming_messages.lock().remove(&stream_key);
        let Some(active) = active else {
            return Ok(());
        };

        let duration_ms = (Utc::now() - active.started_at).num_milliseconds().max(0);
        let message = MessageProjection {
            id: active.id,
            conversation_id: conversation_id.to_string(),
            turn_id: turn_id.to_string(),
            role: MessageRole::System,
            kind: MessageKind::Thinking,
            content_json: json!({
                "text": active.content,
                "status": "done",
                "stream": false,
                "duration_ms": duration_ms,
            }),
            created_at: active.started_at,
        };
        self.db.upsert_message(&message)?;
        self.emit(
            "conversation:message_updated",
            &json!({ "conversation_id": conversation_id, "message": message }),
        );
        Ok(())
    }

    fn finalize_text_stream(&self, conversation_id: &str, turn_id: &str) -> RuntimeResult<()> {
        // Remove text streams for both agent and user roles
        for role in [MessageRole::Agent, MessageRole::User] {
            let stream_key =
                Self::stream_message_key(conversation_id, turn_id, &role, &MessageKind::Text);
            let active = self.streaming_messages.lock().remove(&stream_key);
            if let Some(active) = active {
                let message = MessageProjection {
                    id: active.id,
                    conversation_id: conversation_id.to_string(),
                    turn_id: turn_id.to_string(),
                    role: active.role.clone(),
                    kind: MessageKind::Text,
                    content_json: json!({ "text": active.content, "stream": false }),
                    created_at: active.started_at,
                };
                self.db.upsert_message(&message)?;
                self.emit(
                    "conversation:message_updated",
                    &json!({ "conversation_id": conversation_id, "message": message }),
                );
            }
        }
        Ok(())
    }

    async fn apply_stream_event(
        &self,
        conversation_id: &str,
        turn_id: &str,
        event: RuntimeStreamEvent,
    ) -> RuntimeResult<()> {
        match event {
            RuntimeStreamEvent::StateChanged { status } => {
                self.finalize_thinking_stream(conversation_id, turn_id)?;
                if status == "running" {
                    self.update_runtime_state(conversation_id, |runtime| {
                        runtime.connection_phase = ConnectionPhase::Ready;
                        runtime.session_phase = if self.is_session_in_memory(conversation_id) {
                            SessionPhase::Hot
                        } else {
                            SessionPhase::Cold
                        };
                        runtime.turn_phase = TurnPhase::Running;
                        runtime.last_error = None;
                    })?;
                }
                self.record_lifecycle_event(
                    conversation_id,
                    "ConversationStateChanged",
                    json!({ "status": status }),
                )?;
                self.emit(
                    "conversation:state_changed",
                    &json!({ "conversation_id": conversation_id, "state": self.conversation_state(conversation_id)? }),
                );
            }
            RuntimeStreamEvent::ThinkingChunk { content, .. } => {
                let stream_key = Self::stream_message_key(
                    conversation_id,
                    turn_id,
                    &MessageRole::System,
                    &MessageKind::Thinking,
                );
                let mut stream_messages = self.streaming_messages.lock();
                // When starting a new thinking stream, finalize any active text stream
                // so subsequent MessageChunk creates a new message instead of appending to previous text.
                if !stream_messages.contains_key(&stream_key) {
                    drop(stream_messages);
                    self.finalize_text_stream(conversation_id, turn_id)?;
                    stream_messages = self.streaming_messages.lock();
                }
                let active =
                    stream_messages
                        .entry(stream_key)
                        .or_insert_with(|| ActiveStreamMessage {
                            id: Uuid::new_v4().to_string(),
                            role: MessageRole::System,
                            kind: MessageKind::Thinking,
                            content: String::new(),
                            started_at: Utc::now(),
                        });
                active.content.push_str(&content);
                let message = MessageProjection {
                    id: active.id.clone(),
                    conversation_id: conversation_id.to_string(),
                    turn_id: turn_id.to_string(),
                    role: active.role.clone(),
                    kind: active.kind.clone(),
                    content_json: json!({
                        "text": active.content,
                        "status": "thinking",
                        "stream": true,
                        "duration_ms": serde_json::Value::Null,
                    }),
                    created_at: active.started_at,
                };
                let is_new_stream = !self
                    .db
                    .list_messages(conversation_id)?
                    .iter()
                    .any(|existing| existing.id == message.id);
                drop(stream_messages);
                self.db.upsert_message(&message)?;
                self.emit(
                    if is_new_stream {
                        "conversation:message_appended"
                    } else {
                        "conversation:message_updated"
                    },
                    &json!({ "conversation_id": conversation_id, "message": message }),
                );
            }
            RuntimeStreamEvent::ThinkingComplete { .. } => {
                self.finalize_thinking_stream(conversation_id, turn_id)?;
            }
            RuntimeStreamEvent::MessageChunk { role, content, .. } => {
                if role == "user" && !turn_id.starts_with("history-") {
                    return Ok(());
                }
                self.finalize_thinking_stream(conversation_id, turn_id)?;
                let message_role = Self::role_from_stream(&role);
                let stream_key = Self::stream_message_key(
                    conversation_id,
                    turn_id,
                    &message_role,
                    &MessageKind::Text,
                );
                let mut stream_messages = self.streaming_messages.lock();
                let active =
                    stream_messages
                        .entry(stream_key)
                        .or_insert_with(|| ActiveStreamMessage {
                            id: Uuid::new_v4().to_string(),
                            role: message_role.clone(),
                            kind: MessageKind::Text,
                            content: String::new(),
                            started_at: Utc::now(),
                        });
                active.content.push_str(&content);
                let message = MessageProjection {
                    id: active.id.clone(),
                    conversation_id: conversation_id.to_string(),
                    turn_id: turn_id.to_string(),
                    role: active.role.clone(),
                    kind: active.kind.clone(),
                    content_json: json!({ "text": active.content, "stream": true }),
                    created_at: active.started_at,
                };
                let is_new_stream = !self
                    .db
                    .list_messages(conversation_id)?
                    .iter()
                    .any(|existing| existing.id == message.id);
                drop(stream_messages);
                self.db.upsert_message(&message)?;
                self.record_lifecycle_event(
                    conversation_id,
                    "AgentMessageChunkReceived",
                    serde_json::to_value(&message).unwrap_or_else(|_| json!({})),
                )?;
                let event_name = if is_new_stream {
                    "conversation:message_appended"
                } else {
                    "conversation:message_updated"
                };
                self.emit(
                    event_name,
                    &json!({ "conversation_id": conversation_id, "message": message }),
                );
            }
            RuntimeStreamEvent::MessageComplete { role, content, .. } => {
                if role == "user" && !turn_id.starts_with("history-") {
                    return Ok(());
                }
                self.finalize_thinking_stream(conversation_id, turn_id)?;
                let message_role = Self::role_from_stream(&role);
                let stream_key = Self::stream_message_key(
                    conversation_id,
                    turn_id,
                    &message_role,
                    &MessageKind::Text,
                );
                let active = self.streaming_messages.lock().remove(&stream_key);
                let message = MessageProjection {
                    id: active
                        .as_ref()
                        .map(|stream| stream.id.clone())
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    conversation_id: conversation_id.to_string(),
                    turn_id: turn_id.to_string(),
                    role: message_role,
                    kind: MessageKind::Text,
                    content_json: json!({ "text": content, "stream": false }),
                    created_at: active
                        .as_ref()
                        .map(|stream| stream.started_at)
                        .unwrap_or_else(Utc::now),
                };
                self.db.upsert_message(&message)?;
                self.record_lifecycle_event(
                    conversation_id,
                    "AgentMessageCompleted",
                    serde_json::to_value(&message).unwrap_or_else(|_| json!({})),
                )?;
                self.emit(
                    if active.is_some() {
                        "conversation:message_updated"
                    } else {
                        "conversation:message_appended"
                    },
                    &json!({ "conversation_id": conversation_id, "message": message }),
                );
            }
            RuntimeStreamEvent::Plan { entries, .. } => {
                self.finalize_thinking_stream(conversation_id, turn_id)?;
                let message = MessageProjection {
                    id: format!("{conversation_id}:{turn_id}:plan"),
                    conversation_id: conversation_id.to_string(),
                    turn_id: turn_id.to_string(),
                    role: MessageRole::System,
                    kind: MessageKind::Plan,
                    content_json: json!({ "entries": entries }),
                    created_at: Utc::now(),
                };
                self.db.upsert_message(&message)?;
                self.record_lifecycle_event(
                    conversation_id,
                    "AgentPlanUpdated",
                    serde_json::to_value(&message).unwrap_or_else(|_| json!({})),
                )?;
                self.emit(
                    "conversation:message_appended",
                    &json!({ "conversation_id": conversation_id, "message": message }),
                );
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
                self.finalize_thinking_stream(conversation_id, turn_id)?;
                // Clear any active text stream so subsequent MessageChunk creates a new message.
                // This prevents content after tool calls from being merged with content before tool calls.
                self.finalize_text_stream(conversation_id, turn_id)?;
                let call = ToolCallProjection {
                    id: format!("{conversation_id}:{tool_call_id}"),
                    conversation_id: conversation_id.to_string(),
                    turn_id: turn_id.to_string(),
                    tool_call_id,
                    title,
                    kind,
                    status: match status.as_str() {
                        "running" => ToolCallStatus::Running,
                        "waiting_permission" => ToolCallStatus::WaitingPermission,
                        "completed" => ToolCallStatus::Completed,
                        "failed" => ToolCallStatus::Failed,
                        "cancelled" => ToolCallStatus::Cancelled,
                        _ => ToolCallStatus::Declared,
                    },
                    raw_input_json: raw_input,
                    raw_output_json: raw_output,
                    content_json: content.clone(),
                    diffs_json: diffs.clone(),
                    terminal_ids_json: terminal_ids.clone(),
                    locations_json: locations,
                    started_at: Some(Utc::now()),
                    ended_at: matches!(status.as_str(), "completed" | "failed" | "cancelled")
                        .then_some(Utc::now()),
                };
                self.db.upsert_tool_call(&call)?;
                if diffs != json!([]) {
                    let diff_message = MessageProjection {
                        id: Uuid::new_v4().to_string(),
                        conversation_id: conversation_id.to_string(),
                        turn_id: turn_id.to_string(),
                        role: MessageRole::Tool,
                        kind: MessageKind::Diff,
                        content_json: json!({ "tool_call_id": call.tool_call_id, "diffs": diffs }),
                        created_at: Utc::now(),
                    };
                    self.db.upsert_message(&diff_message)?;
                    self.emit(
                        "conversation:message_appended",
                        &json!({ "conversation_id": conversation_id, "message": diff_message }),
                    );
                }
                self.record_lifecycle_event(
                    conversation_id,
                    "ToolCallUpdated",
                    serde_json::to_value(&call).unwrap_or_else(|_| json!({})),
                )?;
                self.emit(
                    "conversation:tool_call_changed",
                    &json!({ "conversation_id": conversation_id, "tool_call": call }),
                );
            }
            RuntimeStreamEvent::PermissionRequest {
                tool_call_id,
                tool_kind,
                title,
                raw_input,
                paths,
                options,
                ..
            } => {
                self.finalize_thinking_stream(conversation_id, turn_id)?;
                let fingerprint = PolicyEngine::fingerprint(&tool_kind, &title, &raw_input, &paths);
                if let Some(decision) = self
                    .policy_engine
                    .find_session_policy(conversation_id, &fingerprint)?
                {
                    let managed_session = { self.sessions.lock().get(conversation_id).cloned() };
                    if let Some(ManagedSession::Acp(session)) = managed_session {
                        session
                            .resolve_permission(&tool_call_id, decision.decision.clone())
                            .await?;
                    }
                    self.emit(
                        "conversation:permission_resolved",
                        &json!({ "conversation_id": conversation_id, "decision": decision }),
                    );
                } else {
                    let request = PendingPermissionRequest {
                        id: Uuid::new_v4().to_string(),
                        conversation_id: conversation_id.to_string(),
                        turn_id: turn_id.to_string(),
                        tool_call_id: tool_call_id.clone(),
                        fingerprint: fingerprint.clone(),
                        options_json: options.clone(),
                        status: PendingPermissionStatus::Pending,
                        created_at: Utc::now(),
                        resolved_at: None,
                    };
                    self.db.upsert_pending_permission(&request)?;
                    self.record_lifecycle_event(
                        conversation_id,
                        "PermissionRequested",
                        json!({
                            "request_id": request.id,
                            "tool_call_id": tool_call_id,
                            "tool_kind": tool_kind,
                            "title": title,
                            "paths": paths,
                            "fingerprint": fingerprint,
                            "options": options
                        }),
                    )?;
                    self.emit(
                        "conversation:permission_requested",
                        &json!({
                            "conversation_id": conversation_id,
                            "request": {
                                "id": request.id,
                                "conversation_id": conversation_id,
                                "turn_id": turn_id,
                                "tool_call_id": tool_call_id,
                                "fingerprint": fingerprint,
                                "options_json": options,
                                "status": "pending",
                                "created_at": request.created_at,
                                "resolved_at": serde_json::Value::Null
                            }
                        }),
                    );
                }
            }
            RuntimeStreamEvent::TerminalEvent {
                terminal_id,
                event,
                cwd,
                command,
                args,
                stream,
                content,
                exit_code,
                ..
            } => {
                self.finalize_thinking_stream(conversation_id, turn_id)?;
                let existing = self
                    .db
                    .get_terminal_by_remote_id(conversation_id, &terminal_id)?;
                let mut record = existing.unwrap_or(TerminalRecord {
                    id: Uuid::new_v4().to_string(),
                    conversation_id: conversation_id.to_string(),
                    turn_id: turn_id.to_string(),
                    terminal_id: terminal_id.clone(),
                    cwd: cwd.clone().unwrap_or_default(),
                    command: command.clone().unwrap_or_default(),
                    args_json: args.clone(),
                    status: TerminalStatus::Running,
                    stdout_buffer: String::new(),
                    stderr_buffer: String::new(),
                    started_at: Utc::now(),
                    ended_at: None,
                });
                if let Some(cwd) = cwd {
                    record.cwd = cwd;
                }
                if let Some(command) = command {
                    record.command = command;
                }
                if args != json!([]) {
                    record.args_json = args.clone();
                }
                if let Some(stream_name) = stream.clone() {
                    if let Some(chunk) = content.clone() {
                        if stream_name == "stderr" {
                            record.stderr_buffer.push_str(&chunk);
                        } else {
                            record.stdout_buffer.push_str(&chunk);
                        }
                    }
                }
                record.status = match event.as_str() {
                    "exited" => TerminalStatus::Exited,
                    "killed" => TerminalStatus::Killed,
                    "released" => TerminalStatus::Released,
                    "failed" => TerminalStatus::Failed,
                    _ => TerminalStatus::Running,
                };
                if matches!(
                    record.status,
                    TerminalStatus::Exited
                        | TerminalStatus::Killed
                        | TerminalStatus::Released
                        | TerminalStatus::Failed
                ) {
                    record.ended_at = Some(Utc::now());
                }
                self.db.upsert_terminal(&record)?;
                if let Some(chunk) = content {
                    let message = MessageProjection {
                        id: format!(
                            "{conversation_id}:{turn_id}:terminal:{terminal_id}:{}",
                            record.stdout_buffer.len() + record.stderr_buffer.len()
                        ),
                        conversation_id: conversation_id.to_string(),
                        turn_id: turn_id.to_string(),
                        role: MessageRole::Tool,
                        kind: MessageKind::Terminal,
                        content_json: json!({
                            "terminal_id": terminal_id,
                            "event": event,
                            "stream": stream,
                            "content": chunk,
                            "exit_code": exit_code
                        }),
                        created_at: Utc::now(),
                    };
                    self.db.upsert_message(&message)?;
                    self.emit(
                        "conversation:message_appended",
                        &json!({ "conversation_id": conversation_id, "message": message }),
                    );
                    self.emit(
                        "conversation:terminal_output",
                        &json!({
                            "conversation_id": conversation_id,
                            "terminal_id": record.terminal_id,
                            "event": event,
                            "stream": stream,
                            "content": message.content_json.get("content").cloned().unwrap_or_else(|| json!("")),
                            "terminal": record
                        }),
                    );
                } else {
                    self.emit(
                        "conversation:terminal_output",
                        &json!({
                            "conversation_id": conversation_id,
                            "terminal_id": record.terminal_id,
                            "event": event,
                            "stream": serde_json::Value::Null,
                            "content": serde_json::Value::Null,
                            "terminal": record
                        }),
                    );
                }
            }
            RuntimeStreamEvent::Error { message } => {
                self.finalize_thinking_stream(conversation_id, turn_id)?;
                let prefix = format!("{conversation_id}:{turn_id}:");
                self.streaming_messages
                    .lock()
                    .retain(|key, _| !key.starts_with(&prefix));
                let message = MessageProjection {
                    id: Uuid::new_v4().to_string(),
                    conversation_id: conversation_id.to_string(),
                    turn_id: turn_id.to_string(),
                    role: MessageRole::System,
                    kind: MessageKind::Error,
                    content_json: json!({ "message": message }),
                    created_at: Utc::now(),
                };
                self.db.upsert_message(&message)?;
                self.record_lifecycle_event(
                    conversation_id,
                    "TurnFailed",
                    serde_json::to_value(&message).unwrap_or_else(|_| json!({})),
                )?;
                if self.db.get_task_run(conversation_id)?.is_some() {
                    self.db
                        .update_task_run(conversation_id, TaskRunStatus::Failed, None)?;
                    self.emit(
                        "task_run:state_changed",
                        &json!({ "conversation_id": conversation_id, "task_run": self.db.get_task_run(conversation_id)? }),
                    );
                }
                self.emit(
                    "conversation:message_appended",
                    &json!({ "conversation_id": conversation_id, "message": message }),
                );
            }
            RuntimeStreamEvent::TurnFinished { .. } => {
                self.finalize_thinking_stream(conversation_id, turn_id)?;
                let prefix = format!("{conversation_id}:{turn_id}:");
                self.streaming_messages
                    .lock()
                    .retain(|key, _| !key.starts_with(&prefix));
                self.record_lifecycle_event(
                    conversation_id,
                    "TurnCompleted",
                    json!({ "turn_id": turn_id }),
                )?;
                self.emit(
                    "conversation:turn_finished",
                    &json!({ "conversation_id": conversation_id, "turn_id": turn_id, "status": "completed" }),
                );
            }
            RuntimeStreamEvent::ConfigOptionsUpdated { config_options } => {
                self.update_snapshot_config_options(conversation_id, config_options.clone())?;
                self.emit(
                    "conversation:config_updated",
                    &json!({ "conversation_id": conversation_id, "config_options": config_options }),
                );
            }
        }
        Ok(())
    }

    async fn apply_replay_events(
        &self,
        conversation_id: &str,
        loaded: &LoadedSession,
    ) -> RuntimeResult<()> {
        let mut replay_turn_id = Uuid::new_v4().to_string();
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
            self.apply_stream_event(conversation_id, &replay_turn_id, event.clone())
                .await?;
        }
        self.record_lifecycle_event(
            conversation_id,
            "ConversationReplayCompleted",
            json!({ "replayed_events": loaded.replay_events.len() }),
        )?;
        Ok(())
    }

    pub fn conversation_state(&self, conversation_id: &str) -> RuntimeResult<ConversationState> {
        Ok(ConversationState {
            conversation: self.db.get_conversation(conversation_id)?,
            runtime: self.runtime_state(conversation_id),
            binding: self.db.get_binding(conversation_id)?,
            task_run: self.db.get_task_run(conversation_id)?,
            config_options: self.conversation_config_options(conversation_id),
            models: self.conversation_models(conversation_id),
            modes: self.conversation_modes(conversation_id),
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

    fn emit_conversation_state(&self, conversation_id: &str) -> RuntimeResult<()> {
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
        let mut state = self.conversation_state(conversation_id)?;
        state.config_options = config_options;
        self.db.replace_snapshot(
            conversation_id,
            1,
            &serde_json::to_value(&state).unwrap_or_else(|_| Value::Null),
            state.conversation.last_event_seq,
        )?;
        Ok(())
    }

    fn update_snapshot_models(
        &self,
        conversation_id: &str,
        models: AcpSessionModels,
    ) -> RuntimeResult<()> {
        let mut state = self.conversation_state(conversation_id)?;
        state.models = Some(models);
        self.db.replace_snapshot(
            conversation_id,
            1,
            &serde_json::to_value(&state).unwrap_or_else(|_| Value::Null),
            state.conversation.last_event_seq,
        )?;
        Ok(())
    }

    fn update_snapshot_modes(
        &self,
        conversation_id: &str,
        modes: AcpSessionModeState,
    ) -> RuntimeResult<()> {
        let mut state = self.conversation_state(conversation_id)?;
        state.modes = Some(modes);
        self.db.replace_snapshot(
            conversation_id,
            1,
            &serde_json::to_value(&state).unwrap_or_else(|_| Value::Null),
            state.conversation.last_event_seq,
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
