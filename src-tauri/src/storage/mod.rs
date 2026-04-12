use std::{fs, path::PathBuf, sync::Arc};

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{de::DeserializeOwned, Serialize};
use uuid::Uuid;

use crate::domain::*;

#[derive(thiserror::Error, Debug)]
pub enum StorageError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("record not found: {0}")]
    NotFound(String),
}

pub type StorageResult<T> = Result<T, StorageError>;

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    pub fn open_default() -> StorageResult<Self> {
        let db_dir = dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("oneagent");
        fs::create_dir_all(&db_dir)?;
        let db_path = db_dir.join("oneagent.db");
        let conn = Connection::open(db_path)?;
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> StorageResult<()> {
        self.conn.lock().execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS workspaces (
              id TEXT PRIMARY KEY,
              cwd TEXT NOT NULL UNIQUE,
              display_name TEXT NOT NULL,
              trusted INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_profiles (
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              name TEXT NOT NULL,
              command TEXT NOT NULL,
              args_json TEXT NOT NULL,
              env_json TEXT NOT NULL,
              launch_mode TEXT,
              runtime_preference TEXT,
              package_name TEXT,
              package_version TEXT,
              display_source TEXT,
              capabilities_cache_json TEXT NOT NULL,
              enabled INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS conversations (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              agent_profile_id TEXT NOT NULL,
              origin TEXT NOT NULL,
              status TEXT NOT NULL,
              title TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              last_event_seq INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_session_bindings (
              id TEXT PRIMARY KEY,
              conversation_id TEXT NOT NULL UNIQUE,
              adapter_kind TEXT NOT NULL,
              remote_session_id TEXT NOT NULL,
              cwd TEXT NOT NULL,
              load_supported INTEGER NOT NULL,
              source TEXT NOT NULL,
              last_synced_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS task_runs (
              id TEXT PRIMARY KEY,
              conversation_id TEXT NOT NULL UNIQUE,
              workspace_id TEXT NOT NULL,
              agent_profile_id TEXT NOT NULL,
              goal TEXT NOT NULL,
              status TEXT NOT NULL,
              result_summary TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runtime_events (
              seq INTEGER PRIMARY KEY AUTOINCREMENT,
              conversation_id TEXT NOT NULL,
              event_type TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS conversation_snapshots (
              conversation_id TEXT PRIMARY KEY,
              snapshot_version INTEGER NOT NULL,
              state_json TEXT NOT NULL,
              event_seq INTEGER NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS message_projections (
              id TEXT PRIMARY KEY,
              conversation_id TEXT NOT NULL,
              turn_id TEXT NOT NULL,
              role TEXT NOT NULL,
              kind TEXT NOT NULL,
              content_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tool_call_projections (
              id TEXT PRIMARY KEY,
              conversation_id TEXT NOT NULL,
              turn_id TEXT NOT NULL,
              tool_call_id TEXT NOT NULL,
              title TEXT NOT NULL,
              kind TEXT NOT NULL,
              status TEXT NOT NULL,
              raw_input_json TEXT NOT NULL,
              raw_output_json TEXT NOT NULL,
              content_json TEXT NOT NULL DEFAULT '{}',
              diffs_json TEXT NOT NULL DEFAULT '[]',
              terminal_ids_json TEXT NOT NULL DEFAULT '[]',
              locations_json TEXT NOT NULL,
              started_at TEXT,
              ended_at TEXT
            );
            CREATE TABLE IF NOT EXISTS permission_decisions (
              id TEXT PRIMARY KEY,
              conversation_id TEXT NOT NULL,
              tool_call_id TEXT NOT NULL,
              scope TEXT NOT NULL,
              fingerprint TEXT NOT NULL,
              decision TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pending_permission_requests (
              id TEXT PRIMARY KEY,
              conversation_id TEXT NOT NULL,
              turn_id TEXT NOT NULL,
              tool_call_id TEXT NOT NULL,
              fingerprint TEXT NOT NULL,
              options_json TEXT NOT NULL,
              status TEXT NOT NULL,
              created_at TEXT NOT NULL,
              resolved_at TEXT
            );
            CREATE TABLE IF NOT EXISTS mcp_server_configs (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              name TEXT NOT NULL,
              command TEXT NOT NULL,
              args_json TEXT NOT NULL,
              env_json TEXT NOT NULL,
              enabled INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS skill_records (
              id TEXT PRIMARY KEY,
              scope TEXT NOT NULL,
              name TEXT NOT NULL,
              description TEXT NOT NULL,
              location TEXT NOT NULL,
              source_dir TEXT NOT NULL,
              owner TEXT NOT NULL,
              enabled INTEGER NOT NULL,
              diagnostics_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS terminal_records (
              id TEXT PRIMARY KEY,
              conversation_id TEXT NOT NULL,
              turn_id TEXT NOT NULL,
              terminal_id TEXT NOT NULL,
              cwd TEXT NOT NULL,
              command TEXT NOT NULL,
              args_json TEXT NOT NULL,
              status TEXT NOT NULL,
              stdout_buffer TEXT NOT NULL,
              stderr_buffer TEXT NOT NULL,
              started_at TEXT NOT NULL,
              ended_at TEXT
            );
            "#,
        )?;
        self.ensure_column(
            "agent_profiles",
            "launch_mode",
            "ALTER TABLE agent_profiles ADD COLUMN launch_mode TEXT",
        )?;
        self.ensure_column(
            "agent_profiles",
            "runtime_preference",
            "ALTER TABLE agent_profiles ADD COLUMN runtime_preference TEXT",
        )?;
        self.ensure_column(
            "agent_profiles",
            "package_name",
            "ALTER TABLE agent_profiles ADD COLUMN package_name TEXT",
        )?;
        self.ensure_column(
            "agent_profiles",
            "package_version",
            "ALTER TABLE agent_profiles ADD COLUMN package_version TEXT",
        )?;
        self.ensure_column(
            "agent_profiles",
            "display_source",
            "ALTER TABLE agent_profiles ADD COLUMN display_source TEXT",
        )?;
        self.ensure_column(
            "tool_call_projections",
            "content_json",
            "ALTER TABLE tool_call_projections ADD COLUMN content_json TEXT NOT NULL DEFAULT '{}'",
        )?;
        self.ensure_column(
            "tool_call_projections",
            "diffs_json",
            "ALTER TABLE tool_call_projections ADD COLUMN diffs_json TEXT NOT NULL DEFAULT '[]'",
        )?;
        self.ensure_column(
            "tool_call_projections",
            "terminal_ids_json",
            "ALTER TABLE tool_call_projections ADD COLUMN terminal_ids_json TEXT NOT NULL DEFAULT '[]'",
        )?;
        Ok(())
    }

    fn ensure_column(&self, table: &str, column: &str, sql: &str) -> StorageResult<()> {
        let conn = self.conn.lock();
        let pragma = format!("PRAGMA table_info({table})");
        let mut stmt = conn.prepare(&pragma)?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        let existing = rows.collect::<Result<Vec<_>, _>>()?;
        if !existing.iter().any(|name| name == column) {
            conn.execute(sql, [])?;
        }
        Ok(())
    }

    pub fn list_agent_profiles(&self) -> StorageResult<Vec<AgentProfile>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, kind, name, command, args_json, env_json, launch_mode, runtime_preference, package_name, package_version, display_source, capabilities_cache_json, enabled FROM agent_profiles ORDER BY name",
        )?;
        let rows = stmt.query_map([], Self::read_agent_profile)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn upsert_agent_profile(
        &self,
        input: UpsertAgentProfileInput,
    ) -> StorageResult<AgentProfile> {
        let profile_id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
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

    pub fn get_agent_profile(&self, profile_id: &str) -> StorageResult<AgentProfile> {
        self.conn
            .lock()
            .query_row(
                "SELECT id, kind, name, command, args_json, env_json, launch_mode, runtime_preference, package_name, package_version, display_source, capabilities_cache_json, enabled FROM agent_profiles WHERE id = ?1",
                params![profile_id],
                Self::read_agent_profile,
            )
            .map_err(|_| StorageError::NotFound(format!("agent profile {profile_id}")))
    }

    pub fn list_workspaces(&self) -> StorageResult<Vec<Workspace>> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare("SELECT id, cwd, display_name, trusted, created_at, updated_at FROM workspaces ORDER BY updated_at DESC")?;
        let rows = stmt.query_map([], Self::read_workspace)?;
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
                Self::read_workspace,
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
            id: Uuid::new_v4().to_string(),
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
                Self::read_workspace,
            )
            .map_err(|_| StorageError::NotFound(format!("workspace {workspace_id}")))
    }

    pub fn create_conversation(
        &self,
        workspace_id: &str,
        agent_profile_id: &str,
        origin: ConversationOrigin,
        title: String,
    ) -> StorageResult<Conversation> {
        let now = Utc::now();
        let conversation = Conversation {
            id: Uuid::new_v4().to_string(),
            workspace_id: workspace_id.to_string(),
            agent_profile_id: agent_profile_id.to_string(),
            origin,
            status: ConversationStatus::Starting,
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
        let rows = stmt.query_map(params![workspace_id], Self::read_conversation)?;
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
        let rows = stmt.query_map(params![workspace_id, search_pattern], Self::read_conversation)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn get_conversation(&self, conversation_id: &str) -> StorageResult<Conversation> {
        self.conn
            .lock()
            .query_row(
                "SELECT id, workspace_id, agent_profile_id, origin, status, title, created_at, updated_at, last_event_seq FROM conversations WHERE id = ?1",
                params![conversation_id],
                Self::read_conversation,
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
                enum_text(&binding.source),
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
                Self::read_binding,
            )
            .optional()
            .map_err(StorageError::from)
    }

    pub fn create_task_run(
        &self,
        conversation_id: &str,
        workspace_id: &str,
        agent_profile_id: &str,
        goal: &str,
    ) -> StorageResult<TaskRun> {
        let now = Utc::now();
        let task = TaskRun {
            id: Uuid::new_v4().to_string(),
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
                Self::read_task_run,
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
        let rows = stmt.query_map(params![workspace_id], Self::read_task_run)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

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
        let rows = stmt.query_map(params![conversation_id], Self::read_runtime_event)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

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

    pub fn get_snapshot(
        &self,
        conversation_id: &str,
    ) -> StorageResult<Option<ConversationSnapshot>> {
        self.conn
            .lock()
            .query_row(
                "SELECT conversation_id, snapshot_version, state_json, event_seq, created_at FROM conversation_snapshots WHERE conversation_id = ?1",
                params![conversation_id],
                Self::read_snapshot,
            )
            .optional()
            .map_err(StorageError::from)
    }

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
        let rows = stmt.query_map(params![conversation_id], Self::read_message)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

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
        let rows = stmt.query_map(params![conversation_id], Self::read_tool_call)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

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

    pub fn list_permissions(
        &self,
        conversation_id: &str,
    ) -> StorageResult<Vec<PermissionDecision>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, tool_call_id, scope, fingerprint, decision, created_at FROM permission_decisions WHERE conversation_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![conversation_id], Self::read_permission)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn upsert_pending_permission(
        &self,
        request: &PendingPermissionRequest,
    ) -> StorageResult<()> {
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
                Self::read_pending_permission,
            )
            .optional()
            .map_err(StorageError::from)
    }

    pub fn list_pending_permissions(
        &self,
        conversation_id: &str,
    ) -> StorageResult<Vec<PendingPermissionRequest>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, turn_id, tool_call_id, fingerprint, options_json, status, created_at, resolved_at FROM pending_permission_requests WHERE conversation_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id], Self::read_pending_permission)?;
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
                Self::read_terminal,
            )
            .optional()
            .map_err(StorageError::from)
    }

    pub fn list_terminals(&self, conversation_id: &str) -> StorageResult<Vec<TerminalRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, turn_id, terminal_id, cwd, command, args_json, status, stdout_buffer, stderr_buffer, started_at, ended_at FROM terminal_records WHERE conversation_id = ?1 ORDER BY started_at ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id], Self::read_terminal)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn list_workspace_mcp(&self, workspace_id: &str) -> StorageResult<Vec<McpServerConfig>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, name, command, args_json, env_json, enabled FROM mcp_server_configs WHERE workspace_id = ?1 ORDER BY name",
        )?;
        let rows = stmt.query_map(params![workspace_id], Self::read_mcp)?;
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
        let rows = stmt.query_map([], Self::read_skill)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    fn read_workspace(row: &Row<'_>) -> rusqlite::Result<Workspace> {
        Ok(Workspace {
            id: row.get(0)?,
            cwd: row.get(1)?,
            display_name: row.get(2)?,
            trusted: row.get::<_, i64>(3)? != 0,
            created_at: parse_dt(row.get::<_, String>(4)?)?,
            updated_at: parse_dt(row.get::<_, String>(5)?)?,
        })
    }

    fn read_agent_profile(row: &Row<'_>) -> rusqlite::Result<AgentProfile> {
        Ok(AgentProfile {
            id: row.get(0)?,
            kind: parse_enum(&row.get::<_, String>(1)?)?,
            name: row.get(2)?,
            command: row.get(3)?,
            args: from_json(&row.get::<_, String>(4)?)?,
            env: from_json(&row.get::<_, String>(5)?)?,
            launch_mode: row
                .get::<_, Option<String>>(6)?
                .map(|value| parse_enum(&value))
                .transpose()?
                .unwrap_or(AgentLaunchMode::Native),
            runtime_preference: row
                .get::<_, Option<String>>(7)?
                .map(|value| parse_enum(&value))
                .transpose()?,
            package_name: row.get(8)?,
            package_version: row.get(9)?,
            display_source: row
                .get::<_, Option<String>>(10)?
                .map(|value| parse_enum(&value))
                .transpose()?
                .unwrap_or(AgentDisplaySource::Native),
            capabilities_cache: serde_json::from_str(&row.get::<_, String>(11)?)
                .unwrap_or_else(|_| serde_json::json!({})),
            enabled: row.get::<_, i64>(12)? != 0,
        })
    }

    fn read_conversation(row: &Row<'_>) -> rusqlite::Result<Conversation> {
        Ok(Conversation {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            agent_profile_id: row.get(2)?,
            origin: parse_enum(&row.get::<_, String>(3)?)?,
            status: parse_enum(&row.get::<_, String>(4)?)?,
            title: row.get(5)?,
            created_at: parse_dt(row.get::<_, String>(6)?)?,
            updated_at: parse_dt(row.get::<_, String>(7)?)?,
            last_event_seq: row.get(8)?,
        })
    }

    fn read_binding(row: &Row<'_>) -> rusqlite::Result<AgentSessionBinding> {
        Ok(AgentSessionBinding {
            id: row.get(0)?,
            conversation_id: row.get(1)?,
            adapter_kind: parse_enum(&row.get::<_, String>(2)?)?,
            remote_session_id: row.get(3)?,
            cwd: row.get(4)?,
            load_supported: row.get::<_, i64>(5)? != 0,
            source: parse_enum(&row.get::<_, String>(6)?)?,
            last_synced_at: parse_dt(row.get::<_, String>(7)?)?,
        })
    }

    fn read_task_run(row: &Row<'_>) -> rusqlite::Result<TaskRun> {
        Ok(TaskRun {
            id: row.get(0)?,
            conversation_id: row.get(1)?,
            workspace_id: row.get(2)?,
            agent_profile_id: row.get(3)?,
            goal: row.get(4)?,
            status: parse_enum(&row.get::<_, String>(5)?)?,
            result_summary: row.get(6)?,
            created_at: parse_dt(row.get::<_, String>(7)?)?,
            updated_at: parse_dt(row.get::<_, String>(8)?)?,
        })
    }

    fn read_runtime_event(row: &Row<'_>) -> rusqlite::Result<RuntimeEvent> {
        Ok(RuntimeEvent {
            seq: row.get(0)?,
            conversation_id: row.get(1)?,
            event_type: row.get(2)?,
            payload_json: serde_json::from_str(&row.get::<_, String>(3)?)
                .unwrap_or_else(|_| serde_json::json!({})),
            created_at: parse_dt(row.get::<_, String>(4)?)?,
        })
    }

    fn read_snapshot(row: &Row<'_>) -> rusqlite::Result<ConversationSnapshot> {
        Ok(ConversationSnapshot {
            conversation_id: row.get(0)?,
            snapshot_version: row.get(1)?,
            state_json: serde_json::from_str(&row.get::<_, String>(2)?)
                .unwrap_or_else(|_| serde_json::json!({})),
            event_seq: row.get(3)?,
            created_at: parse_dt(row.get::<_, String>(4)?)?,
        })
    }

    fn read_message(row: &Row<'_>) -> rusqlite::Result<MessageProjection> {
        Ok(MessageProjection {
            id: row.get(0)?,
            conversation_id: row.get(1)?,
            turn_id: row.get(2)?,
            role: parse_enum(&row.get::<_, String>(3)?)?,
            kind: parse_enum(&row.get::<_, String>(4)?)?,
            content_json: serde_json::from_str(&row.get::<_, String>(5)?)
                .unwrap_or_else(|_| serde_json::json!({})),
            created_at: parse_dt(row.get::<_, String>(6)?)?,
        })
    }

    fn read_tool_call(row: &Row<'_>) -> rusqlite::Result<ToolCallProjection> {
        Ok(ToolCallProjection {
            id: row.get(0)?,
            conversation_id: row.get(1)?,
            turn_id: row.get(2)?,
            tool_call_id: row.get(3)?,
            title: row.get(4)?,
            kind: row.get(5)?,
            status: parse_enum(&row.get::<_, String>(6)?)?,
            raw_input_json: serde_json::from_str(&row.get::<_, String>(7)?)
                .unwrap_or_else(|_| serde_json::json!({})),
            raw_output_json: serde_json::from_str(&row.get::<_, String>(8)?)
                .unwrap_or_else(|_| serde_json::json!({})),
            content_json: serde_json::from_str(&row.get::<_, String>(9)?)
                .unwrap_or_else(|_| serde_json::json!({})),
            diffs_json: serde_json::from_str(&row.get::<_, String>(10)?)
                .unwrap_or_else(|_| serde_json::json!([])),
            terminal_ids_json: serde_json::from_str(&row.get::<_, String>(11)?)
                .unwrap_or_else(|_| serde_json::json!([])),
            locations_json: serde_json::from_str(&row.get::<_, String>(12)?)
                .unwrap_or_else(|_| serde_json::json!({})),
            started_at: row
                .get::<_, Option<String>>(13)?
                .map(parse_dt)
                .transpose()?,
            ended_at: row
                .get::<_, Option<String>>(14)?
                .map(parse_dt)
                .transpose()?,
        })
    }

    fn read_permission(row: &Row<'_>) -> rusqlite::Result<PermissionDecision> {
        Ok(PermissionDecision {
            id: row.get(0)?,
            conversation_id: row.get(1)?,
            tool_call_id: row.get(2)?,
            scope: row.get(3)?,
            fingerprint: row.get(4)?,
            decision: parse_enum(&row.get::<_, String>(5)?)?,
            created_at: parse_dt(row.get::<_, String>(6)?)?,
        })
    }

    fn read_pending_permission(row: &Row<'_>) -> rusqlite::Result<PendingPermissionRequest> {
        Ok(PendingPermissionRequest {
            id: row.get(0)?,
            conversation_id: row.get(1)?,
            turn_id: row.get(2)?,
            tool_call_id: row.get(3)?,
            fingerprint: row.get(4)?,
            options_json: serde_json::from_str(&row.get::<_, String>(5)?)
                .unwrap_or_else(|_| serde_json::json!([])),
            status: parse_enum(&row.get::<_, String>(6)?)?,
            created_at: parse_dt(row.get::<_, String>(7)?)?,
            resolved_at: row.get::<_, Option<String>>(8)?.map(parse_dt).transpose()?,
        })
    }

    fn read_mcp(row: &Row<'_>) -> rusqlite::Result<McpServerConfig> {
        Ok(McpServerConfig {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            name: row.get(2)?,
            command: row.get(3)?,
            args_json: serde_json::from_str(&row.get::<_, String>(4)?)
                .unwrap_or_else(|_| serde_json::json!([])),
            env_json: serde_json::from_str(&row.get::<_, String>(5)?)
                .unwrap_or_else(|_| serde_json::json!({})),
            enabled: row.get::<_, i64>(6)? != 0,
        })
    }

    fn read_skill(row: &Row<'_>) -> rusqlite::Result<SkillRecord> {
        Ok(SkillRecord {
            id: row.get(0)?,
            scope: parse_enum(&row.get::<_, String>(1)?)?,
            name: row.get(2)?,
            description: row.get(3)?,
            location: row.get(4)?,
            source_dir: row.get(5)?,
            owner: parse_enum(&row.get::<_, String>(6)?)?,
            enabled: row.get::<_, i64>(7)? != 0,
            diagnostics_json: serde_json::from_str(&row.get::<_, String>(8)?)
                .unwrap_or_else(|_| serde_json::json!({})),
        })
    }

    fn read_terminal(row: &Row<'_>) -> rusqlite::Result<TerminalRecord> {
        Ok(TerminalRecord {
            id: row.get(0)?,
            conversation_id: row.get(1)?,
            turn_id: row.get(2)?,
            terminal_id: row.get(3)?,
            cwd: row.get(4)?,
            command: row.get(5)?,
            args_json: serde_json::from_str(&row.get::<_, String>(6)?)
                .unwrap_or_else(|_| serde_json::json!([])),
            status: parse_enum(&row.get::<_, String>(7)?)?,
            stdout_buffer: row.get(8)?,
            stderr_buffer: row.get(9)?,
            started_at: parse_dt(row.get::<_, String>(10)?)?,
            ended_at: row
                .get::<_, Option<String>>(11)?
                .map(parse_dt)
                .transpose()?,
        })
    }
}

fn enum_text<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(ToOwned::to_owned))
        .unwrap_or_default()
}

fn parse_enum<T: DeserializeOwned>(value: &str) -> rusqlite::Result<T> {
    serde_json::from_value(serde_json::Value::String(value.to_string())).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn parse_dt(value: String) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&value)
        .map(|v| v.with_timezone(&Utc))
        .map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })
}

fn to_json<T: Serialize>(value: &T) -> StorageResult<String> {
    Ok(serde_json::to_string(value)?)
}

fn from_json<T: DeserializeOwned>(value: &str) -> rusqlite::Result<T> {
    serde_json::from_str(value).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}
