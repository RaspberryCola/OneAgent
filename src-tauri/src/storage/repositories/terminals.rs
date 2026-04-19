use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::{TerminalRecord, McpServerConfig};
use crate::storage::error::StorageResult;
use crate::storage::mappers::terminal::read_terminal;
use crate::storage::mappers::mcp::read_mcp;
use crate::storage::mappers::enum_text;

pub struct TerminalRepository<'a> {
    conn: &'a Connection,
}

impl<'a> TerminalRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    pub fn upsert(&self, terminal: &TerminalRecord) -> StorageResult<()> {
        self.conn.execute(
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
            
            .query_row(
                "SELECT id, conversation_id, turn_id, terminal_id, cwd, command, args_json, status, stdout_buffer, stderr_buffer, started_at, ended_at FROM terminal_records WHERE conversation_id = ?1 AND terminal_id = ?2 ORDER BY started_at DESC LIMIT 1",
                params![conversation_id, terminal_id],
                read_terminal,
            )
            .optional()
            .map_err(crate::storage::error::StorageError::from)
    }

    pub fn list(&self, conversation_id: &str) -> StorageResult<Vec<TerminalRecord>> {
        let conn = self.conn;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, turn_id, terminal_id, cwd, command, args_json, status, stdout_buffer, stderr_buffer, started_at, ended_at FROM terminal_records WHERE conversation_id = ?1 ORDER BY started_at ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id], read_terminal)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(crate::storage::error::StorageError::from)
    }
}

pub struct McpRepository<'a> {
    conn: &'a Connection,
}

impl<'a> McpRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    pub fn list_by_workspace(&self, workspace_id: &str) -> StorageResult<Vec<McpServerConfig>> {
        let conn = self.conn;
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, name, command, args_json, env_json, enabled FROM mcp_server_configs WHERE workspace_id = ?1 ORDER BY name",
        )?;
        let rows = stmt.query_map(params![workspace_id], read_mcp)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(crate::storage::error::StorageError::from)
    }

    pub fn upsert(&self, config: &McpServerConfig) -> StorageResult<()> {
        self.conn.execute(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::TerminalRecord;
    use crate::storage::sqlite::connection::Database;
    use serde_json::json;

    fn create_test_terminal() -> TerminalRecord {
        TerminalRecord {
            id: "term_1".to_string(),
            conversation_id: "conv_1".to_string(),
            turn_id: "turn_1".to_string(),
            terminal_id: "remote_term_1".to_string(),
            cwd: "/tmp".to_string(),
            command: "echo".to_string(),
            args_json: json!["hello"],
            status: crate::domain::TerminalStatus::Running,
            stdout_buffer: String::new(),
            stderr_buffer: String::new(),
            started_at: chrono::Utc::now(),
            ended_at: None,
        }
    }

    #[test]
    fn upserts_and_retrieves_terminal() {
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn.lock();
        let repo = TerminalRepository::new(&conn);
        let terminal = create_test_terminal();

        repo.upsert(&terminal).unwrap();

        let retrieved = repo
            .get_by_remote_id("conv_1", "remote_term_1")
            .unwrap();
        assert!(retrieved.is_some());
        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.terminal_id, "remote_term_1");
        assert_eq!(retrieved.command, "echo");
    }

    #[test]
    fn updates_terminal_status_and_buffers() {
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn.lock();
        let repo = TerminalRepository::new(&conn);
        let mut terminal = create_test_terminal();

        repo.upsert(&terminal).unwrap();

        // Update status and buffers
        terminal.status = crate::domain::TerminalStatus::Exited;
        terminal.stdout_buffer = "output".to_string();
        terminal.stderr_buffer = "error".to_string();
        terminal.ended_at = Some(chrono::Utc::now());

        repo.upsert(&terminal).unwrap();

        let retrieved = repo
            .get_by_remote_id("conv_1", "remote_term_1")
            .unwrap()
            .unwrap();
        assert_eq!(retrieved.status, crate::domain::TerminalStatus::Exited);
        assert_eq!(retrieved.stdout_buffer, "output");
        assert_eq!(retrieved.stderr_buffer, "error");
        assert!(retrieved.ended_at.is_some());
    }

    #[test]
    fn lists_terminals_for_conversation() {
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn.lock();
        let repo = TerminalRepository::new(&conn);

        let terminal1 = TerminalRecord {
            id: "term_1".to_string(),
            conversation_id: "conv_1".to_string(),
            turn_id: "turn_1".to_string(),
            terminal_id: "remote_term_1".to_string(),
            cwd: "/tmp".to_string(),
            command: "echo".to_string(),
            args_json: json!["hello"],
            status: crate::domain::TerminalStatus::Running,
            stdout_buffer: String::new(),
            stderr_buffer: String::new(),
            started_at: chrono::Utc::now(),
            ended_at: None,
        };

        let terminal2 = TerminalRecord {
            id: "term_2".to_string(),
            conversation_id: "conv_1".to_string(),
            turn_id: "turn_1".to_string(),
            terminal_id: "remote_term_2".to_string(),
            cwd: "/home".to_string(),
            command: "ls".to_string(),
            args_json: json!["-la"],
            status: crate::domain::TerminalStatus::Running,
            stdout_buffer: String::new(),
            stderr_buffer: String::new(),
            started_at: chrono::Utc::now(),
            ended_at: None,
        };

        repo.upsert(&terminal1).unwrap();
        repo.upsert(&terminal2).unwrap();

        let terminals = repo.list("conv_1").unwrap();
        assert_eq!(terminals.len(), 2);
    }

    #[test]
    fn handles_multiple_terminals_per_conversation() {
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn.lock();
        let repo = TerminalRepository::new(&conn);

        let terminal1 = TerminalRecord {
            id: "term_1".to_string(),
            conversation_id: "conv_1".to_string(),
            turn_id: "turn_1".to_string(),
            terminal_id: "remote_term_1".to_string(),
            cwd: "/tmp".to_string(),
            command: "echo".to_string(),
            args_json: json!["hello"],
            status: crate::domain::TerminalStatus::Running,
            stdout_buffer: String::new(),
            stderr_buffer: String::new(),
            started_at: chrono::Utc::now(),
            ended_at: None,
        };

        let terminal2 = TerminalRecord {
            id: "term_2".to_string(),
            conversation_id: "conv_1".to_string(),
            turn_id: "turn_1".to_string(),
            terminal_id: "remote_term_1".to_string(), // Same terminal_id
            cwd: "/home".to_string(),
            command: "ls".to_string(),
            args_json: json!["-la"],
            status: crate::domain::TerminalStatus::Exited,
            stdout_buffer: "files".to_string(),
            stderr_buffer: String::new(),
            started_at: chrono::Utc::now() + chrono::Duration::seconds(1),
            ended_at: Some(chrono::Utc::now()),
        };

        repo.upsert(&terminal1).unwrap();
        repo.upsert(&terminal2).unwrap();

        // get_by_remote_id should return the most recent one
        let retrieved = repo
            .get_by_remote_id("conv_1", "remote_term_1")
            .unwrap()
            .unwrap();
        assert_eq!(retrieved.status, crate::domain::TerminalStatus::Exited);
        assert_eq!(retrieved.stdout_buffer, "files");
    }
}
