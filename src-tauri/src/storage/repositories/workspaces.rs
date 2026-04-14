use chrono::Utc;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

use crate::domain::{Workspace, AgentSessionBinding, AgentSessionSource};
use crate::storage::error::{StorageError, StorageResult};
use crate::storage::mappers::binding::read_binding;
use crate::storage::mappers::workspace::read_workspace;
use crate::storage::mappers::enum_text;

pub struct WorkspaceRepository<'a> {
    conn: &'a Arc<Mutex<Connection>>,
}

impl<'a> WorkspaceRepository<'a> {
    pub fn new(conn: &'a Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }

    pub fn list(&self) -> StorageResult<Vec<Workspace>> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare("SELECT id, cwd, display_name, trusted, created_at, updated_at FROM workspaces ORDER BY updated_at DESC")?;
        let rows = stmt.query_map([], read_workspace)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn open(&self, cwd: &str) -> StorageResult<Workspace> {
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

    pub fn get(&self, workspace_id: &str) -> StorageResult<Workspace> {
        self.conn
            .lock()
            .query_row(
                "SELECT id, cwd, display_name, trusted, created_at, updated_at FROM workspaces WHERE id = ?1",
                params![workspace_id],
                read_workspace,
            )
            .map_err(|_| StorageError::NotFound(format!("workspace {workspace_id}")))
    }
}

pub struct BindingRepository<'a> {
    conn: &'a Arc<Mutex<Connection>>,
}

impl<'a> BindingRepository<'a> {
    pub fn new(conn: &'a Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }

    pub fn upsert(&self, binding: &AgentSessionBinding) -> StorageResult<()> {
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

    pub fn get(&self, conversation_id: &str) -> StorageResult<Option<AgentSessionBinding>> {
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
}
