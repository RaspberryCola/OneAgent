use std::path::PathBuf;

use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::domain::*;
use crate::storage::error::{StorageError, StorageResult};
use crate::storage::mappers::{
    enum_text,
    agent_profile::read_agent_profile,
    binding::read_binding,
    conversation::read_conversation,
    mcp::read_mcp,
    message::read_message,
    permission::{read_permission, read_pending_permission},
    runtime_event::read_runtime_event,
    skill::read_skill,
    snapshot::read_snapshot,
    task_run::read_task_run,
    terminal::read_terminal,
    tool_call::read_tool_call,
    workspace::read_workspace,
};
use crate::storage::Database;

// This module provides backward-compatible facade methods for Database
// All methods delegate to the underlying connection, just like the original implementation

impl Database {
    // ========== Agent Profiles ==========
    pub fn list_agent_profiles(&self) -> StorageResult<Vec<AgentProfile>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, kind, name, command, args_json, env_json, launch_mode, runtime_preference, package_name, package_version, display_source, capabilities_cache_json, enabled FROM agent_profiles ORDER BY name",
        )?;
        let rows = stmt.query_map([], read_agent_profile)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn upsert_agent_profile(
        &self,
        input: UpsertAgentProfileInput,
    ) -> StorageResult<AgentProfile> {
        let profile_id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let existing_capabilities = self
            .conn
            .lock()
            .query_row(
                "SELECT capabilities_cache_json FROM agent_profiles WHERE id = ?1",
                params![profile_id.clone()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        let profile = AgentProfile {
            id: profile_id,
            kind: input.kind,
            name: input.name,
            command: input.command,
            args: input.args,
            env: input.env,
            launch_mode: input.launch_mode,
            runtime_preference: input.runtime_preference,
            package_name: input.package_name,
            package_version: input.package_version,
            display_source: input.display_source,
            capabilities_cache: existing_capabilities,
            enabled: input.enabled,
        };
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO agent_profiles (
              id, kind, name, command, args_json, env_json, launch_mode, runtime_preference,
              package_name, package_version, display_source, capabilities_cache_json, enabled
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(id) DO UPDATE SET
              kind = excluded.kind,
              name = excluded.name,
              command = excluded.command,
              args_json = excluded.args_json,
              env_json = excluded.env_json,
              launch_mode = excluded.launch_mode,
              runtime_preference = excluded.runtime_preference,
              package_name = excluded.package_name,
              package_version = excluded.package_version,
              display_source = excluded.display_source,
              enabled = excluded.enabled
            "#,
            params![
                profile.id,
                enum_text(&profile.kind),
                profile.name,
                profile.command,
                to_json(&profile.args)?,
                to_json(&profile.env)?,
                enum_text(&profile.launch_mode),
                profile.runtime_preference.as_ref().map(enum_text),
                profile.package_name,
                profile.package_version,
                enum_text(&profile.display_source),
                profile.capabilities_cache.to_string(),
                profile.enabled as i64
            ],
        )?;
        Ok(profile)
    }

    pub fn update_agent_capabilities(
        &self,
        profile_id: &str,
        capabilities: &AgentCapabilities,
    ) -> StorageResult<()> {
        self.conn.lock().execute(
            "UPDATE agent_profiles SET capabilities_cache_json = ?2 WHERE id = ?1",
            params![profile_id, serde_json::to_string(capabilities)?],
        )?;
        Ok(())
    }

    pub fn delete_agent_profile(&self, profile_id: &str) -> StorageResult<()> {
        self.conn.lock().execute(
            "DELETE FROM agent_profiles WHERE id = ?1",
            params![profile_id],
        )?;
        Ok(())
    }

    pub fn is_agent_profile_referenced(&self, profile_id: &str) -> StorageResult<bool> {
        let count: i64 = self.conn.lock().query_row(
            "SELECT COUNT(1) FROM conversations WHERE agent_profile_id = ?1",
            params![profile_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn get_agent_profile(&self, profile_id: &str) -> StorageResult<AgentProfile> {
        self.conn
            .lock()
            .query_row(
                "SELECT id, kind, name, command, args_json, env_json, launch_mode, runtime_preference, package_name, package_version, display_source, capabilities_cache_json, enabled FROM agent_profiles WHERE id = ?1",
                params![profile_id],
                read_agent_profile,
            )
            .map_err(|_| StorageError::NotFound(format!("agent profile {profile_id}")))
    }

    // ========== Workspaces ==========
    pub fn list_workspaces(&self) -> StorageResult<Vec<Workspace>> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare("SELECT id, cwd, display_name, trusted, created_at, updated_at FROM workspaces ORDER BY updated_at DESC")?;
        let rows = stmt.query_map([], read_workspace)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn open_workspace(&self, cwd: &str) -> StorageResult<Workspace> {
        let now = Utc::now();
        let display_name = PathBuf::from(cwd)
            .file_name()
            .map(|v| v.to_string_lossy().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| cwd.to_string());
        let existing = self
            .conn
            .lock()
            .query_row(
                "SELECT id, cwd, display_name, trusted, created_at, updated_at FROM workspaces WHERE cwd = ?1",
                params![cwd],
                read_workspace,
            )
            .optional()?;
        if let Some(mut workspace) = existing {
            workspace.updated_at = now;
            self.conn.lock().execute(
                "UPDATE workspaces SET updated_at = ?2 WHERE id = ?1",
                params![workspace.id, now.to_rfc3339()],
            )?;
            return Ok(workspace);
        }
        let workspace = Workspace {
            id: uuid::Uuid::new_v4().to_string(),
            cwd: cwd.to_string(),
            display_name,
            trusted: true,
            created_at: now,
            updated_at: now,
        };
        self.conn.lock().execute(
            "INSERT INTO workspaces (id, cwd, display_name, trusted, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                workspace.id,
                workspace.cwd,
                workspace.display_name,
                workspace.trusted as i64,
                workspace.created_at.to_rfc3339(),
                workspace.updated_at.to_rfc3339()
            ],
        )?;
        Ok(workspace)
    }

    pub fn get_workspace(&self, workspace_id: &str) -> StorageResult<Workspace> {
        self.conn
            .lock()
            .query_row(
                "SELECT id, cwd, display_name, trusted, created_at, updated_at FROM workspaces WHERE id = ?1",
                params![workspace_id],
                read_workspace,
            )
            .map_err(|_| StorageError::NotFound(format!("workspace {workspace_id}")))
    }

    // ========== Conversations ==========
    pub fn create_conversation(
        &self,
        workspace_id: &str,
        agent_profile_id: &str,
        origin: ConversationOrigin,
        title: String,
    ) -> StorageResult<Conversation> {
        let now = Utc::now();
        let conversation = Conversation {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: workspace_id.to_string(),
            agent_profile_id: agent_profile_id.to_string(),
            origin,
            status: ConversationStatus::Initializing,
            title,
            created_at: now,
            updated_at: now,
            last_event_seq: 0,
        };
        self.conn.lock().execute(
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
        Ok(conversation)
    }

    pub fn update_conversation_status(
        &self,
        conversation_id: &str,
        status: ConversationStatus,
    ) -> StorageResult<()> {
        self.conn.lock().execute(
            "UPDATE conversations SET status = ?2, updated_at = ?3 WHERE id = ?1",
            params![conversation_id, enum_text(&status), Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn list_conversations(
        &self,
        workspace_id: &str,
        include_tasks: bool,
    ) -> StorageResult<Vec<Conversation>> {
        let sql = if include_tasks {
            "SELECT id, workspace_id, agent_profile_id, origin, status, title, created_at, updated_at, last_event_seq FROM conversations WHERE workspace_id = ?1 ORDER BY updated_at DESC"
        } else {
            "SELECT id, workspace_id, agent_profile_id, origin, status, title, created_at, updated_at, last_event_seq FROM conversations WHERE workspace_id = ?1 AND origin != 'worker_task' ORDER BY updated_at DESC"
        };
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![workspace_id], read_conversation)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn search_conversations(
        &self,
        workspace_id: &str,
        query: &str,
        include_tasks: bool,
    ) -> StorageResult<Vec<Conversation>> {
        let search_pattern = format!("%{}%", query);
        let sql = if include_tasks {
            "SELECT id, workspace_id, agent_profile_id, origin, status, title, created_at, updated_at, last_event_seq \
             FROM conversations \
             WHERE workspace_id = ?1 AND title LIKE ?2 \
             ORDER BY updated_at DESC"
        } else {
            "SELECT id, workspace_id, agent_profile_id, origin, status, title, created_at, updated_at, last_event_seq \
             FROM conversations \
             WHERE workspace_id = ?1 AND origin != 'worker_task' AND title LIKE ?2 \
             ORDER BY updated_at DESC"
        };
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(
            params![workspace_id, search_pattern],
            read_conversation,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn get_conversation(&self, conversation_id: &str) -> StorageResult<Conversation> {
        self.conn
            .lock()
            .query_row(
                "SELECT id, workspace_id, agent_profile_id, origin, status, title, created_at, updated_at, last_event_seq FROM conversations WHERE id = ?1",
                params![conversation_id],
                read_conversation,
            )
            .map_err(|_| StorageError::NotFound(format!("conversation {conversation_id}")))
    }

    pub fn delete_conversation(&self, conversation_id: &str) -> StorageResult<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM terminal_records WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        tx.execute(
            "DELETE FROM pending_permission_requests WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        tx.execute(
            "DELETE FROM permission_decisions WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        tx.execute(
            "DELETE FROM tool_call_projections WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        tx.execute(
            "DELETE FROM message_projections WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        tx.execute(
            "DELETE FROM runtime_events WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        tx.execute(
            "DELETE FROM conversation_snapshots WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        tx.execute(
            "DELETE FROM task_runs WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        tx.execute(
            "DELETE FROM agent_session_bindings WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        let deleted = tx.execute(
            "DELETE FROM conversations WHERE id = ?1",
            params![conversation_id],
        )?;
        if deleted == 0 {
            return Err(StorageError::NotFound(format!(
                "conversation {conversation_id}"
            )));
        }
        tx.commit()?;
        Ok(())
    }

    // ========== Bindings ==========
    pub fn upsert_binding(&self, binding: &AgentSessionBinding) -> StorageResult<()> {
        self.conn.lock().execute(
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
                enum_text::<AgentSessionSource>(&binding.source),
                binding.last_synced_at.to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn get_binding(&self, conversation_id: &str) -> StorageResult<Option<AgentSessionBinding>> {
        self.conn
            .lock()
            .query_row(
                "SELECT id, conversation_id, adapter_kind, remote_session_id, cwd, load_supported, source, last_synced_at FROM agent_session_bindings WHERE conversation_id = ?1",
                params![conversation_id],
                read_binding,
            )
            .optional()
            .map_err(StorageError::from)
    }

    // ========== Task Runs ==========
    pub fn create_task_run(
        &self,
        conversation_id: &str,
        workspace_id: &str,
        agent_profile_id: &str,
        goal: &str,
    ) -> StorageResult<TaskRun> {
        let now = Utc::now();
        let task = TaskRun {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            workspace_id: workspace_id.to_string(),
            agent_profile_id: agent_profile_id.to_string(),
            goal: goal.to_string(),
            status: TaskRunStatus::Pending,
            result_summary: None,
            created_at: now,
            updated_at: now,
        };
        self.conn.lock().execute(
            r#"
            INSERT INTO task_runs (id, conversation_id, workspace_id, agent_profile_id, goal, status, result_summary, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                task.id,
                task.conversation_id,
                task.workspace_id,
                task.agent_profile_id,
                task.goal,
                enum_text(&task.status),
                task.result_summary,
                task.created_at.to_rfc3339(),
                task.updated_at.to_rfc3339()
            ],
        )?;
        Ok(task)
    }

    pub fn get_task_run(&self, conversation_id: &str) -> StorageResult<Option<TaskRun>> {
        self.conn
            .lock()
            .query_row(
                "SELECT id, conversation_id, workspace_id, agent_profile_id, goal, status, result_summary, created_at, updated_at FROM task_runs WHERE conversation_id = ?1",
                params![conversation_id],
                read_task_run,
            )
            .optional()
            .map_err(StorageError::from)
    }

    pub fn update_task_run(
        &self,
        conversation_id: &str,
        status: TaskRunStatus,
        result_summary: Option<&str>,
    ) -> StorageResult<()> {
        self.conn.lock().execute(
            "UPDATE task_runs SET status = ?2, result_summary = COALESCE(?3, result_summary), updated_at = ?4 WHERE conversation_id = ?1",
            params![
                conversation_id,
                enum_text(&status),
                result_summary,
                Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn list_task_runs(&self, workspace_id: &str) -> StorageResult<Vec<TaskRun>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, workspace_id, agent_profile_id, goal, status, result_summary, created_at, updated_at FROM task_runs WHERE workspace_id = ?1 ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map(params![workspace_id], read_task_run)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    // ========== Events ==========
    pub fn append_event(
        &self,
        conversation_id: &str,
        event_type: &str,
        payload: &serde_json::Value,
    ) -> StorageResult<RuntimeEvent> {
        let now = Utc::now();
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO runtime_events (conversation_id, event_type, payload_json, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![conversation_id, event_type, payload.to_string(), now.to_rfc3339()],
        )?;
        let seq = conn.last_insert_rowid();
        conn.execute(
            "UPDATE conversations SET last_event_seq = ?2, updated_at = ?3 WHERE id = ?1",
            params![conversation_id, seq, now.to_rfc3339()],
        )?;
        Ok(RuntimeEvent {
            seq,
            conversation_id: conversation_id.to_string(),
            event_type: event_type.to_string(),
            payload_json: payload.clone(),
            created_at: now,
        })
    }

    pub fn list_events(&self, conversation_id: &str) -> StorageResult<Vec<RuntimeEvent>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT seq, conversation_id, event_type, payload_json, created_at FROM runtime_events WHERE conversation_id = ?1 ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id], read_runtime_event)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    // ========== Snapshots ==========
    pub fn replace_snapshot(
        &self,
        conversation_id: &str,
        snapshot_version: i64,
        state: &serde_json::Value,
        event_seq: i64,
    ) -> StorageResult<()> {
        self.conn.lock().execute(
            r#"
            INSERT INTO conversation_snapshots (conversation_id, snapshot_version, state_json, event_seq, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(conversation_id) DO UPDATE SET
              snapshot_version = excluded.snapshot_version,
              state_json = excluded.state_json,
              event_seq = excluded.event_seq,
              created_at = excluded.created_at
            "#,
            params![conversation_id, snapshot_version, state.to_string(), event_seq, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn get_snapshot(&self, conversation_id: &str) -> StorageResult<Option<ConversationSnapshot>> {
        self.conn
            .lock()
            .query_row(
                "SELECT conversation_id, snapshot_version, state_json, event_seq, created_at FROM conversation_snapshots WHERE conversation_id = ?1",
                params![conversation_id],
                read_snapshot,
            )
            .optional()
            .map_err(StorageError::from)
    }

    // ========== Messages ==========
    pub fn upsert_message(&self, message: &MessageProjection) -> StorageResult<()> {
        self.conn.lock().execute(
            r#"
            INSERT INTO message_projections (id, conversation_id, turn_id, role, kind, content_json, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET content_json = excluded.content_json
            "#,
            params![
                message.id,
                message.conversation_id,
                message.turn_id,
                enum_text(&message.role),
                enum_text(&message.kind),
                message.content_json.to_string(),
                message.created_at.to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn list_messages(&self, conversation_id: &str) -> StorageResult<Vec<MessageProjection>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, turn_id, role, kind, content_json, created_at FROM message_projections WHERE conversation_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id], read_message)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    // ========== Tool Calls ==========
    pub fn upsert_tool_call(&self, call: &ToolCallProjection) -> StorageResult<()> {
        self.conn.lock().execute(
            r#"
            INSERT INTO tool_call_projections (id, conversation_id, turn_id, tool_call_id, title, kind, status, raw_input_json, raw_output_json, content_json, diffs_json, terminal_ids_json, locations_json, started_at, ended_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            ON CONFLICT(id) DO UPDATE SET
              status = excluded.status,
              raw_output_json = excluded.raw_output_json,
              content_json = excluded.content_json,
              diffs_json = excluded.diffs_json,
              terminal_ids_json = excluded.terminal_ids_json,
              locations_json = excluded.locations_json,
              ended_at = excluded.ended_at
            "#,
            params![
                call.id,
                call.conversation_id,
                call.turn_id,
                call.tool_call_id,
                call.title,
                call.kind,
                enum_text(&call.status),
                call.raw_input_json.to_string(),
                call.raw_output_json.to_string(),
                call.content_json.to_string(),
                call.diffs_json.to_string(),
                call.terminal_ids_json.to_string(),
                call.locations_json.to_string(),
                call.started_at.map(|v| v.to_rfc3339()),
                call.ended_at.map(|v| v.to_rfc3339())
            ],
        )?;
        Ok(())
    }

    pub fn list_tool_calls(&self, conversation_id: &str) -> StorageResult<Vec<ToolCallProjection>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, turn_id, tool_call_id, title, kind, status, raw_input_json, raw_output_json, content_json, diffs_json, terminal_ids_json, locations_json, started_at, ended_at FROM tool_call_projections WHERE conversation_id = ?1 ORDER BY COALESCE(started_at, '') ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id], read_tool_call)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    // ========== Permissions ==========
    pub fn record_permission_decision(&self, decision: &PermissionDecision) -> StorageResult<()> {
        self.conn.lock().execute(
            "INSERT INTO permission_decisions (id, conversation_id, tool_call_id, scope, fingerprint, decision, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                decision.id,
                decision.conversation_id,
                decision.tool_call_id,
                decision.scope,
                decision.fingerprint,
                enum_text(&decision.decision),
                decision.created_at.to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn list_permissions(&self, conversation_id: &str) -> StorageResult<Vec<PermissionDecision>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, tool_call_id, scope, fingerprint, decision, created_at FROM permission_decisions WHERE conversation_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![conversation_id], read_permission)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn upsert_pending_permission(&self, request: &PendingPermissionRequest) -> StorageResult<()> {
        self.conn.lock().execute(
            r#"
            INSERT INTO pending_permission_requests (id, conversation_id, turn_id, tool_call_id, fingerprint, options_json, status, created_at, resolved_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(id) DO UPDATE SET
              fingerprint = excluded.fingerprint,
              options_json = excluded.options_json,
              status = excluded.status,
              resolved_at = excluded.resolved_at
            "#,
            params![
                request.id,
                request.conversation_id,
                request.turn_id,
                request.tool_call_id,
                request.fingerprint,
                request.options_json.to_string(),
                enum_text(&request.status),
                request.created_at.to_rfc3339(),
                request.resolved_at.map(|value| value.to_rfc3339()),
            ],
        )?;
        Ok(())
    }

    pub fn get_pending_permission_by_tool_call(
        &self,
        conversation_id: &str,
        tool_call_id: &str,
    ) -> StorageResult<Option<PendingPermissionRequest>> {
        self.conn
            .lock()
            .query_row(
                "SELECT id, conversation_id, turn_id, tool_call_id, fingerprint, options_json, status, created_at, resolved_at FROM pending_permission_requests WHERE conversation_id = ?1 AND tool_call_id = ?2 ORDER BY created_at DESC LIMIT 1",
                params![conversation_id, tool_call_id],
                read_pending_permission,
            )
            .optional()
            .map_err(StorageError::from)
    }

    pub fn list_pending_permissions(&self, conversation_id: &str) -> StorageResult<Vec<PendingPermissionRequest>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, turn_id, tool_call_id, fingerprint, options_json, status, created_at, resolved_at FROM pending_permission_requests WHERE conversation_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id], read_pending_permission)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn update_pending_permission_status(
        &self,
        request_id: &str,
        status: PendingPermissionStatus,
    ) -> StorageResult<()> {
        self.conn.lock().execute(
            "UPDATE pending_permission_requests SET status = ?2, resolved_at = ?3 WHERE id = ?1",
            params![request_id, enum_text(&status), Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn cancel_pending_permissions_for_turn(&self, conversation_id: &str) -> StorageResult<()> {
        self.conn.lock().execute(
            "UPDATE pending_permission_requests SET status = 'cancelled', resolved_at = ?2 WHERE conversation_id = ?1 AND status = 'pending'",
            params![conversation_id, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    // ========== Terminals ==========
    pub fn upsert_terminal(&self, terminal: &TerminalRecord) -> StorageResult<()> {
        self.conn.lock().execute(
            r#"
            INSERT INTO terminal_records (id, conversation_id, turn_id, terminal_id, cwd, command, args_json, status, stdout_buffer, stderr_buffer, started_at, ended_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(id) DO UPDATE SET
              status = excluded.status,
              stdout_buffer = excluded.stdout_buffer,
              stderr_buffer = excluded.stderr_buffer,
              ended_at = excluded.ended_at
            "#,
            params![
                terminal.id,
                terminal.conversation_id,
                terminal.turn_id,
                terminal.terminal_id,
                terminal.cwd,
                terminal.command,
                terminal.args_json.to_string(),
                enum_text(&terminal.status),
                terminal.stdout_buffer,
                terminal.stderr_buffer,
                terminal.started_at.to_rfc3339(),
                terminal.ended_at.map(|value| value.to_rfc3339()),
            ],
        )?;
        Ok(())
    }

    pub fn get_terminal_by_remote_id(
        &self,
        conversation_id: &str,
        terminal_id: &str,
    ) -> StorageResult<Option<TerminalRecord>> {
        self.conn
            .lock()
            .query_row(
                "SELECT id, conversation_id, turn_id, terminal_id, cwd, command, args_json, status, stdout_buffer, stderr_buffer, started_at, ended_at FROM terminal_records WHERE conversation_id = ?1 AND terminal_id = ?2 ORDER BY started_at DESC LIMIT 1",
                params![conversation_id, terminal_id],
                read_terminal,
            )
            .optional()
            .map_err(StorageError::from)
    }

    pub fn list_terminals(&self, conversation_id: &str) -> StorageResult<Vec<TerminalRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, turn_id, terminal_id, cwd, command, args_json, status, stdout_buffer, stderr_buffer, started_at, ended_at FROM terminal_records WHERE conversation_id = ?1 ORDER BY started_at ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id], read_terminal)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    // ========== MCP ==========
    pub fn list_workspace_mcp(&self, workspace_id: &str) -> StorageResult<Vec<McpServerConfig>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, name, command, args_json, env_json, enabled FROM mcp_server_configs WHERE workspace_id = ?1 ORDER BY name",
        )?;
        let rows = stmt.query_map(params![workspace_id], read_mcp)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn upsert_workspace_mcp(&self, config: &McpServerConfig) -> StorageResult<()> {
        self.conn.lock().execute(
            r#"
            INSERT INTO mcp_server_configs (id, workspace_id, name, command, args_json, env_json, enabled)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              command = excluded.command,
              args_json = excluded.args_json,
              env_json = excluded.env_json,
              enabled = excluded.enabled
            "#,
            params![
                config.id,
                config.workspace_id,
                config.name,
                config.command,
                config.args_json.to_string(),
                config.env_json.to_string(),
                config.enabled as i64
            ],
        )?;
        Ok(())
    }

    // ========== Skills ==========
    pub fn replace_workspace_skills(
        &self,
        workspace: &Workspace,
        skills: &[SkillRecord],
    ) -> StorageResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM skill_records WHERE scope = 'project' OR scope = 'agent_specific'",
            [],
        )?;
        for skill in skills {
            let enabled = match skill.scope {
                SkillScope::Project | SkillScope::AgentSpecific => {
                    workspace.trusted && skill.enabled
                }
                SkillScope::User => skill.enabled,
            };
            conn.execute(
                "INSERT INTO skill_records (id, scope, name, description, location, source_dir, owner, enabled, diagnostics_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    skill.id,
                    enum_text(&skill.scope),
                    skill.name,
                    skill.description,
                    skill.location,
                    skill.source_dir,
                    enum_text(&skill.owner),
                    enabled as i64,
                    skill.diagnostics_json.to_string()
                ],
            )?;
        }
        Ok(())
    }

    pub fn list_skills(&self) -> StorageResult<Vec<SkillRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, scope, name, description, location, source_dir, owner, enabled, diagnostics_json FROM skill_records ORDER BY name",
        )?;
        let rows = stmt.query_map([], read_skill)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }
}

fn to_json<T: Serialize>(value: &T) -> StorageResult<String> {
    Ok(serde_json::to_string(value)?)
}
