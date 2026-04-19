use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};

use crate::domain::{
    AgentSessionBinding, Conversation, ConversationStatus, PermissionDecision, TaskRun, TaskRunStatus,
};
use crate::storage::error::{StorageError, StorageResult};
use crate::storage::mappers::{enum_text, task_run::read_task_run};
use crate::storage::Database;

impl Database {
    pub fn with_transaction<T, F>(&self, f: F) -> StorageResult<T>
    where
        F: FnOnce(&Transaction<'_>) -> StorageResult<T>,
    {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let result = f(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn create_conversation_atomic(
        &self,
        conversation: &Conversation,
        binding: &AgentSessionBinding,
        lifecycle_event_type: &str,
        lifecycle_payload: &serde_json::Value,
        snapshot_state: &serde_json::Value,
    ) -> StorageResult<()> {
        self.with_transaction(|tx| {
            tx.execute(
                r#"
                INSERT INTO conversations (id, workspace_id, agent_profile_id, origin, status, title, created_at, updated_at, last_event_seq)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
                params![
                    conversation.id,
                    conversation.workspace_id,
                    conversation.agent_profile_id,
                    enum_text(&conversation.origin),
                    enum_text(&conversation.status),
                    conversation.title,
                    conversation.created_at.to_rfc3339(),
                    conversation.updated_at.to_rfc3339(),
                    conversation.last_event_seq
                ],
            )?;

            tx.execute(
                r#"
                INSERT INTO agent_session_bindings (id, conversation_id, adapter_kind, remote_session_id, cwd, load_supported, source, last_synced_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ON CONFLICT(conversation_id) DO UPDATE SET
                  adapter_kind = excluded.adapter_kind,
                  remote_session_id = excluded.remote_session_id,
                  cwd = excluded.cwd,
                  load_supported = excluded.load_supported,
                  source = excluded.source,
                  last_synced_at = excluded.last_synced_at
                "#,
                params![
                    binding.id,
                    binding.conversation_id,
                    enum_text(&binding.adapter_kind),
                    binding.remote_session_id,
                    binding.cwd,
                    binding.load_supported as i64,
                    enum_text(&binding.source),
                    binding.last_synced_at.to_rfc3339(),
                ],
            )?;

            tx.execute(
                "INSERT INTO runtime_events (conversation_id, event_type, payload_json, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    conversation.id,
                    lifecycle_event_type,
                    lifecycle_payload.to_string(),
                    Utc::now().to_rfc3339()
                ],
            )?;
            let event_seq = tx.last_insert_rowid();
            tx.execute(
                "UPDATE conversations SET last_event_seq = ?2, updated_at = ?3 WHERE id = ?1",
                params![conversation.id, event_seq, Utc::now().to_rfc3339()],
            )?;

            tx.execute(
                r#"
                INSERT INTO conversation_snapshots (conversation_id, snapshot_version, state_json, event_seq, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(conversation_id) DO UPDATE SET
                  snapshot_version = excluded.snapshot_version,
                  state_json = excluded.state_json,
                  event_seq = excluded.event_seq,
                  created_at = excluded.created_at
                "#,
                params![
                    conversation.id,
                    1_i64,
                    snapshot_state.to_string(),
                    event_seq,
                    Utc::now().to_rfc3339()
                ],
            )?;
            Ok(())
        })
    }

    pub fn import_conversation_atomic(
        &self,
        conversation: &Conversation,
        binding: &AgentSessionBinding,
        messages: &[crate::domain::MessageProjection],
        tool_calls: &[crate::domain::ToolCallProjection],
        terminal_records: &[crate::domain::TerminalRecord],
        events: &[crate::domain::RuntimeEvent],
        snapshot_state: &serde_json::Value,
    ) -> StorageResult<()> {
        self.with_transaction(|tx| {
            tx.execute(
                r#"
                INSERT INTO conversations (id, workspace_id, agent_profile_id, origin, status, title, created_at, updated_at, last_event_seq)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
                params![
                    conversation.id,
                    conversation.workspace_id,
                    conversation.agent_profile_id,
                    enum_text(&conversation.origin),
                    enum_text(&conversation.status),
                    conversation.title,
                    conversation.created_at.to_rfc3339(),
                    conversation.updated_at.to_rfc3339(),
                    conversation.last_event_seq
                ],
            )?;

            tx.execute(
                r#"
                INSERT INTO agent_session_bindings (id, conversation_id, adapter_kind, remote_session_id, cwd, load_supported, source, last_synced_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                "#,
                params![
                    binding.id,
                    binding.conversation_id,
                    enum_text(&binding.adapter_kind),
                    binding.remote_session_id,
                    binding.cwd,
                    binding.load_supported,
                    enum_text(&binding.source),
                    binding.last_synced_at.to_rfc3339()
                ],
            )?;

            for msg in messages {
                crate::storage::repositories::MessageRepository::new(tx).upsert(msg)?;
            }
            for tc in tool_calls {
                crate::storage::repositories::ToolCallRepository::new(tx).upsert(tc)?;
            }
            for term in terminal_records {
                crate::storage::repositories::TerminalRepository::new(tx).upsert(term)?;
            }
            for ev in events {
                tx.execute(
                    "INSERT INTO runtime_events (conversation_id, event_type, payload_json, created_at) VALUES (?1, ?2, ?3, ?4)",
                    params![ev.conversation_id, ev.event_type, ev.payload_json.to_string(), ev.created_at.to_rfc3339()],
                )?;
            }

            let event_seq = tx.last_insert_rowid();

            tx.execute(
                r#"
                INSERT INTO conversation_snapshots (conversation_id, snapshot_version, state_json, event_seq, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                "#,
                params![
                    conversation.id,
                    1_i64,
                    snapshot_state.to_string(),
                    event_seq,
                    Utc::now().to_rfc3339()
                ],
            )?;

            Ok(())
        })
    }
    pub fn create_task_run_atomic(
        &self,
        conversation: &Conversation,
        task_run: &TaskRun,
        binding: &AgentSessionBinding,
        lifecycle_event_type: &str,
        lifecycle_payload: &serde_json::Value,
        snapshot_state: &serde_json::Value,
    ) -> StorageResult<()> {
        self.with_transaction(|tx| {
            tx.execute(
                r#"
                INSERT INTO conversations (id, workspace_id, agent_profile_id, origin, status, title, created_at, updated_at, last_event_seq)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
                params![
                    conversation.id,
                    conversation.workspace_id,
                    conversation.agent_profile_id,
                    enum_text(&conversation.origin),
                    enum_text(&conversation.status),
                    conversation.title,
                    conversation.created_at.to_rfc3339(),
                    conversation.updated_at.to_rfc3339(),
                    conversation.last_event_seq
                ],
            )?;

            tx.execute(
                r#"
                INSERT INTO task_runs (id, conversation_id, workspace_id, agent_profile_id, goal, status, result_summary, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
                params![
                    task_run.id,
                    task_run.conversation_id,
                    task_run.workspace_id,
                    task_run.agent_profile_id,
                    task_run.goal,
                    enum_text(&task_run.status),
                    task_run.result_summary,
                    task_run.created_at.to_rfc3339(),
                    task_run.updated_at.to_rfc3339()
                ],
            )?;
            tx.execute(
                "UPDATE task_runs SET status = ?2, updated_at = ?3 WHERE conversation_id = ?1",
                params![
                    task_run.conversation_id,
                    enum_text(&TaskRunStatus::Running),
                    Utc::now().to_rfc3339()
                ],
            )?;

            tx.execute(
                r#"
                INSERT INTO agent_session_bindings (id, conversation_id, adapter_kind, remote_session_id, cwd, load_supported, source, last_synced_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ON CONFLICT(conversation_id) DO UPDATE SET
                  adapter_kind = excluded.adapter_kind,
                  remote_session_id = excluded.remote_session_id,
                  cwd = excluded.cwd,
                  load_supported = excluded.load_supported,
                  source = excluded.source,
                  last_synced_at = excluded.last_synced_at
                "#,
                params![
                    binding.id,
                    binding.conversation_id,
                    enum_text(&binding.adapter_kind),
                    binding.remote_session_id,
                    binding.cwd,
                    binding.load_supported as i64,
                    enum_text(&binding.source),
                    binding.last_synced_at.to_rfc3339(),
                ],
            )?;

            tx.execute(
                "INSERT INTO runtime_events (conversation_id, event_type, payload_json, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    conversation.id,
                    lifecycle_event_type,
                    lifecycle_payload.to_string(),
                    Utc::now().to_rfc3339()
                ],
            )?;
            let event_seq = tx.last_insert_rowid();
            tx.execute(
                "UPDATE conversations SET last_event_seq = ?2, updated_at = ?3 WHERE id = ?1",
                params![conversation.id, event_seq, Utc::now().to_rfc3339()],
            )?;

            tx.execute(
                r#"
                INSERT INTO conversation_snapshots (conversation_id, snapshot_version, state_json, event_seq, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(conversation_id) DO UPDATE SET
                  snapshot_version = excluded.snapshot_version,
                  state_json = excluded.state_json,
                  event_seq = excluded.event_seq,
                  created_at = excluded.created_at
                "#,
                params![
                    conversation.id,
                    1_i64,
                    snapshot_state.to_string(),
                    event_seq,
                    Utc::now().to_rfc3339()
                ],
            )?;
            Ok(())
        })
    }

    pub fn resolve_permission_atomic(
        &self,
        decision: &PermissionDecision,
        pending_request_id: &str,
    ) -> StorageResult<()> {
        self.with_transaction(|tx| {
            tx.execute(
                "INSERT INTO permission_decisions (id, conversation_id, tool_call_id, scope, fingerprint, decision, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    decision.id,
                    decision.conversation_id,
                    decision.tool_call_id,
                    decision.scope,
                    decision.fingerprint,
                    enum_text(&decision.decision),
                    decision.created_at.to_rfc3339(),
                ],
            )?;
            let updated = tx.execute(
                "UPDATE pending_permission_requests SET status = ?2, resolved_at = ?3 WHERE id = ?1",
                params![
                    pending_request_id,
                    enum_text(&crate::domain::PendingPermissionStatus::Resolved),
                    Utc::now().to_rfc3339()
                ],
            )?;
            if updated == 0 {
                return Err(StorageError::NotFound(format!(
                    "pending permission request {pending_request_id}"
                )));
            }
            Ok(())
        })
    }

    pub fn cancel_turn_atomic(
        &self,
        conversation_id: &str,
        conversation_status: &ConversationStatus,
    ) -> StorageResult<Option<TaskRun>> {
        self.with_transaction(|tx| {
            tx.execute(
                "UPDATE pending_permission_requests SET status = 'cancelled', resolved_at = ?2 WHERE conversation_id = ?1 AND status = 'pending'",
                params![conversation_id, Utc::now().to_rfc3339()],
            )?;
            tx.execute(
                "UPDATE task_runs SET status = ?2, result_summary = ?3, updated_at = ?4 WHERE conversation_id = ?1",
                params![
                    conversation_id,
                    enum_text(&TaskRunStatus::Cancelled),
                    "cancelled",
                    Utc::now().to_rfc3339()
                ],
            )?;
            tx.execute(
                "INSERT INTO runtime_events (conversation_id, event_type, payload_json, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    conversation_id,
                    "TurnCancelled",
                    serde_json::json!({}).to_string(),
                    Utc::now().to_rfc3339()
                ],
            )?;
            let event_seq = tx.last_insert_rowid();
            let updated = tx.execute(
                "UPDATE conversations SET status = ?4, last_event_seq = ?2, updated_at = ?3 WHERE id = ?1",
                params![conversation_id, event_seq, Utc::now().to_rfc3339(), enum_text(conversation_status)],
            )?;
            if updated == 0 {
                return Err(StorageError::NotFound(format!(
                    "conversation {conversation_id}"
                )));
            }
            let task = tx
                .query_row(
                    "SELECT id, conversation_id, workspace_id, agent_profile_id, goal, status, result_summary, created_at, updated_at FROM task_runs WHERE conversation_id = ?1",
                    params![conversation_id],
                    read_task_run,
                )
                .optional()?;
            Ok(task)
        })
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;
    use std::collections::BTreeMap;
    use uuid::Uuid;

    use crate::domain::{
        AgentKind, AgentSessionBinding, AgentSessionSource, Conversation, ConversationOrigin,
        ConversationRuntimeState, ConversationState, ConversationStatus, ConnectionPhase,
        SessionPhase, TurnPhase,
    };
    use crate::storage::{sqlite::connection::Database, StorageError};

    fn build_conversation(id: &str) -> Conversation {
        let now = Utc::now();
        Conversation {
            id: id.to_string(),
            workspace_id: "ws_1".to_string(),
            agent_profile_id: "profile_1".to_string(),
            origin: ConversationOrigin::OneagentManaged,
            status: ConversationStatus::Initializing,
            title: "test conversation".to_string(),
            created_at: now,
            updated_at: now,
            last_event_seq: 0,
        }
    }

    fn build_binding(conversation_id: &str) -> AgentSessionBinding {
        AgentSessionBinding {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            adapter_kind: AgentKind::Acp,
            remote_session_id: "remote_1".to_string(),
            cwd: "/tmp".to_string(),
            load_supported: true,
            source: AgentSessionSource::New,
            last_synced_at: Utc::now(),
        }
    }

    #[test]
    fn with_transaction_rolls_back_on_error() {
        let db = Database::new_in_memory().unwrap();
        let ws = db.open_workspace("/tmp").unwrap();
        let _profile = db
            .upsert_agent_profile(crate::domain::UpsertAgentProfileInput {
                id: Some("profile_1".to_string()),
                kind: AgentKind::Acp,
                name: "p".to_string(),
                command: "agent".to_string(),
                args: vec![],
                env: BTreeMap::new(),
                launch_mode: crate::domain::AgentLaunchMode::Native,
                runtime_preference: None,
                package_name: None,
                package_version: None,
                display_source: crate::domain::AgentDisplaySource::Native,
                enabled: true,
            })
            .unwrap();

        let now = Utc::now();
        let conv_id = "conv_rollback";
        let result: Result<(), StorageError> = db.with_transaction(|tx| {
            tx.execute(
                r#"
                INSERT INTO conversations (id, workspace_id, agent_profile_id, origin, status, title, created_at, updated_at, last_event_seq)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
                rusqlite::params![
                    conv_id,
                    ws.id,
                    "profile_1",
                    "oneagent_managed",
                    "initializing",
                    "rollback",
                    now.to_rfc3339(),
                    now.to_rfc3339(),
                    0_i64
                ],
            )?;
            Err(StorageError::NotFound("force rollback".to_string()))
        });

        assert!(result.is_err());
        assert!(db.get_conversation(conv_id).is_err());
    }

    #[test]
    fn create_conversation_atomic_writes_binding_event_and_snapshot() {
        let db = Database::new_in_memory().unwrap();
        let ws = db.open_workspace("/tmp").unwrap();
        let _profile = db
            .upsert_agent_profile(crate::domain::UpsertAgentProfileInput {
                id: Some("profile_1".to_string()),
                kind: AgentKind::Acp,
                name: "p".to_string(),
                command: "agent".to_string(),
                args: vec![],
                env: BTreeMap::new(),
                launch_mode: crate::domain::AgentLaunchMode::Native,
                runtime_preference: None,
                package_name: None,
                package_version: None,
                display_source: crate::domain::AgentDisplaySource::Native,
                enabled: true,
            })
            .unwrap();

        let conversation = build_conversation("conv_atomic");
        let binding = build_binding(&conversation.id);
        let state = ConversationState {
            conversation: conversation.clone(),
            runtime: ConversationRuntimeState {
                connection_phase: ConnectionPhase::Ready,
                session_phase: SessionPhase::Hot,
                turn_phase: TurnPhase::Idle,
                last_error: None,
                last_transition_at: Utc::now(),
            },
            binding: Some(binding.clone()),
            task_run: None,
            config_options: vec![],
            models: None,
            modes: None,
            pending_permissions: vec![],
        };

        db.create_conversation_atomic(
            &Conversation {
                workspace_id: ws.id.clone(),
                ..conversation
            },
            &binding,
            "ConversationCreated",
            &json!({ "origin": "oneagent_managed" }),
            &serde_json::to_value(&state).unwrap(),
        )
        .unwrap();

        let persisted = db.get_conversation("conv_atomic").unwrap();
        assert_eq!(persisted.workspace_id, ws.id);
        assert!(db.get_binding("conv_atomic").unwrap().is_some());
        assert_eq!(db.list_events("conv_atomic").unwrap().len(), 1);
        assert!(db.get_snapshot("conv_atomic").unwrap().is_some());
    }
}
