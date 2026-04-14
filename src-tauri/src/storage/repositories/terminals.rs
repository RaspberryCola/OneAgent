use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::Arc;

use crate::domain::{TerminalRecord, McpServerConfig};
use crate::storage::error::StorageResult;
use crate::storage::mappers::terminal::read_terminal;
use crate::storage::mappers::mcp::read_mcp;
use crate::storage::mappers::enum_text;

pub struct TerminalRepository<'a> {
    conn: &'a Arc<Mutex<Connection>>,
}

impl<'a> TerminalRepository<'a> {
    pub fn new(conn: &'a Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }

    pub fn upsert(&self, terminal: &TerminalRecord) -> StorageResult<()> {
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

    pub fn get_by_remote_id(
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
            .map_err(crate::storage::error::StorageError::from)
    }

    pub fn list(&self, conversation_id: &str) -> StorageResult<Vec<TerminalRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, turn_id, terminal_id, cwd, command, args_json, status, stdout_buffer, stderr_buffer, started_at, ended_at FROM terminal_records WHERE conversation_id = ?1 ORDER BY started_at ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id], read_terminal)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(crate::storage::error::StorageError::from)
    }
}

pub struct McpRepository<'a> {
    conn: &'a Arc<Mutex<Connection>>,
}

impl<'a> McpRepository<'a> {
    pub fn new(conn: &'a Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }

    pub fn list_by_workspace(&self, workspace_id: &str) -> StorageResult<Vec<McpServerConfig>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, name, command, args_json, env_json, enabled FROM mcp_server_configs WHERE workspace_id = ?1 ORDER BY name",
        )?;
        let rows = stmt.query_map(params![workspace_id], read_mcp)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(crate::storage::error::StorageError::from)
    }

    pub fn upsert(&self, config: &McpServerConfig) -> StorageResult<()> {
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
}
