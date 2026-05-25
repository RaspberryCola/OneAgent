//! Session lifecycle management for conversations.
//!
//! This module contains methods for creating, importing, and deleting conversations,
//! as well as task run creation.

use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

use crate::{
    agent_adapters::{
        acp::AcpLiveSession,
        compat::CompatAdapter,
        AgentAdapter, AgentSessionHandle, LoadedSession, RuntimeStreamEvent,
    },
    domain::*,
};

use super::{
    snapshot_model::RuntimeSnapshotState,
    EventEmitter, ManagedSession, RuntimeError, RuntimeResult,
};

impl super::Runtime {
    /// Creates a new conversation with an agent session.
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

    /// Preview session configuration without creating a conversation.
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

    /// Imports an existing remote session as a conversation.
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

            match event {
                RuntimeStreamEvent::MessageComplete { role, content, .. } => {
                    messages.push(MessageProjection {
                        id: Uuid::new_v4().to_string(),
                        conversation_id: conversation.id.clone(),
                        turn_id: replay_turn_id.clone(),
                        role: Self::role_from_stream(role),
                        kind: MessageKind::Text,
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
                    tool_calls.push(ToolCallProjection {
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
                        ended_at: matches!(
                            status,
                            ToolCallStatus::Completed | ToolCallStatus::Failed | ToolCallStatus::Cancelled
                        )
                            .then_some(Utc::now()),
                    });
                }
                RuntimeStreamEvent::TerminalEvent {
                    terminal_id,
                    event: ev,
                    cwd,
                    command,
                    args,
                    ..
                } => {
                    if ev == "started" {
                        terminals.push(TerminalRecord {
                            id: terminal_id.clone(),
                            conversation_id: conversation.id.clone(),
                            turn_id: replay_turn_id.clone(),
                            terminal_id: terminal_id.clone(),
                            cwd: cwd.clone().unwrap_or_default(),
                            command: command.clone().unwrap_or_default(),
                            args_json: serde_json::json!(args),
                            status: TerminalStatus::Running,
                            stdout_buffer: String::new(),
                            stderr_buffer: String::new(),
                            started_at: Utc::now(),
                            ended_at: None,
                        });
                    }
                }
                RuntimeStreamEvent::Error { message } => {
                    messages.push(MessageProjection {
                        id: Uuid::new_v4().to_string(),
                        conversation_id: conversation.id.clone(),
                        turn_id: replay_turn_id.clone(),
                        role: MessageRole::System,
                        kind: MessageKind::Error,
                        content_json: serde_json::json!({ "message": message }),
                        created_at: Utc::now(),
                    });
                }
                _ => {}
            }
        }

        events.push(RuntimeEvent {
            seq: 0,
            conversation_id: conversation.id.clone(),
            event_type: "ConversationImported".to_string(),
            payload_json: serde_json::json!({ "remote_session_id": remote_session_id }),
            created_at: Utc::now(),
        });
        events.push(RuntimeEvent {
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

    /// Deletes a conversation and cleans up resources.
    pub async fn delete_conversation(&self, conversation_id: &str) -> RuntimeResult<()> {
        let conversation = self.db.get_conversation(conversation_id)?;
        let managed_session = self.session_manager.remove(conversation_id);
        self.state_cache.remove_runtime_state(conversation_id);
        self.state_cache.clear_terminal_records_for_conversation(conversation_id);
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
                        adapter_kind: super::enum_text(&binding.adapter_kind),
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
        self.state_cache.clear_streaming_messages_for_conversation(conversation_id);
        self.db.delete_conversation(conversation_id)?;
        self.emit(
            "conversation:deleted",
            &json!({ "conversation_id": conversation_id }),
        );
        Ok(())
    }

    /// Creates a new task run (worker task) with an agent session.
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
}