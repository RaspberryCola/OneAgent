use parking_lot::Mutex;
use rusqlite::Connection;

use crate::storage::error::StorageResult;

pub struct MigrationManager<'a> {
    conn: &'a Mutex<Connection>,
}

impl<'a> MigrationManager<'a> {
    pub fn new(conn: &'a Mutex<Connection>) -> Self {
        Self { conn }
    }

    pub fn migrate(&self) -> StorageResult<()> {
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
}
