use chrono::Utc;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::Arc;

use crate::domain::{
    PermissionDecision, PendingPermissionRequest, PendingPermissionStatus,
};
use crate::storage::error::StorageResult;
use crate::storage::mappers::permission::{read_permission, read_pending_permission};
use crate::storage::mappers::enum_text;

pub struct PermissionRepository<'a> {
    conn: &'a Arc<Mutex<Connection>>,
}

impl<'a> PermissionRepository<'a> {
    pub fn new(conn: &'a Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }

    pub fn record_decision(&self, decision: &PermissionDecision) -> StorageResult<()> {
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

    pub fn list_decisions(&self, conversation_id: &str) -> StorageResult<Vec<PermissionDecision>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, tool_call_id, scope, fingerprint, decision, created_at FROM permission_decisions WHERE conversation_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![conversation_id], read_permission)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(crate::storage::error::StorageError::from)
    }

    pub fn upsert_pending(&self, request: &PendingPermissionRequest) -> StorageResult<()> {
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

    pub fn get_pending_by_tool_call(
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
            .map_err(crate::storage::error::StorageError::from)
    }

    pub fn list_pending(&self, conversation_id: &str) -> StorageResult<Vec<PendingPermissionRequest>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, turn_id, tool_call_id, fingerprint, options_json, status, created_at, resolved_at FROM pending_permission_requests WHERE conversation_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id], read_pending_permission)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(crate::storage::error::StorageError::from)
    }

    pub fn update_pending_status(
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

    pub fn cancel_pending_for_turn(&self, conversation_id: &str) -> StorageResult<()> {
        self.conn.lock().execute(
            "UPDATE pending_permission_requests SET status = 'cancelled', resolved_at = ?2 WHERE conversation_id = ?1 AND status = 'pending'",
            params![conversation_id, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }
}
