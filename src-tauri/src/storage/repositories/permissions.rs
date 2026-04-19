use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::{
    PermissionDecision, PendingPermissionRequest, PendingPermissionStatus,
};
use crate::storage::error::StorageResult;
use crate::storage::mappers::permission::{read_permission, read_pending_permission};
use crate::storage::mappers::enum_text;

pub struct PermissionRepository<'a> {
    conn: &'a Connection,
}

impl<'a> PermissionRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    pub fn record_decision(&self, decision: &PermissionDecision) -> StorageResult<()> {
        self.conn.execute(
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
        let conn = self.conn;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, tool_call_id, scope, fingerprint, decision, created_at FROM permission_decisions WHERE conversation_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![conversation_id], read_permission)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(crate::storage::error::StorageError::from)
    }

    pub fn upsert_pending(&self, request: &PendingPermissionRequest) -> StorageResult<()> {
        self.conn.execute(
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
            
            .query_row(
                "SELECT id, conversation_id, turn_id, tool_call_id, fingerprint, options_json, status, created_at, resolved_at FROM pending_permission_requests WHERE conversation_id = ?1 AND tool_call_id = ?2 ORDER BY created_at DESC LIMIT 1",
                params![conversation_id, tool_call_id],
                read_pending_permission,
            )
            .optional()
            .map_err(crate::storage::error::StorageError::from)
    }

    pub fn list_pending(&self, conversation_id: &str) -> StorageResult<Vec<PendingPermissionRequest>> {
        let conn = self.conn;
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
        self.conn.execute(
            "UPDATE pending_permission_requests SET status = ?2, resolved_at = ?3 WHERE id = ?1",
            params![request_id, enum_text(&status), Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn cancel_pending_for_turn(&self, conversation_id: &str) -> StorageResult<()> {
        self.conn.execute(
            "UPDATE pending_permission_requests SET status = 'cancelled', resolved_at = ?2 WHERE conversation_id = ?1 AND status = 'pending'",
            params![conversation_id, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{PermissionDecision, PermissionDecisionKind, PendingPermissionRequest, PendingPermissionStatus};
    use crate::storage::sqlite::connection::Database;
    use serde_json::json;

    fn create_test_decision() -> PermissionDecision {
        PermissionDecision {
            id: "dec_1".to_string(),
            conversation_id: "conv_1".to_string(),
            tool_call_id: "call_1".to_string(),
            scope: "session".to_string(),
            fingerprint: "fp_123".to_string(),
            decision: PermissionDecisionKind::AllowAlways,
            created_at: chrono::Utc::now(),
        }
    }

    fn create_test_pending_request() -> PendingPermissionRequest {
        PendingPermissionRequest {
            id: "req_1".to_string(),
            conversation_id: "conv_1".to_string(),
            turn_id: "turn_1".to_string(),
            tool_call_id: "call_1".to_string(),
            fingerprint: "fp_123".to_string(),
            options_json: json!([{"optionId": "allow", "kind": "allow_once"}]),
            status: PendingPermissionStatus::Pending,
            created_at: chrono::Utc::now(),
            resolved_at: None,
        }
    }

    #[test]
    fn records_and_retrieves_permission_decision() {
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn.lock();
        let repo = PermissionRepository::new(&conn);
        let decision = create_test_decision();

        repo.record_decision(&decision).unwrap();

        let decisions = repo.list_decisions("conv_1").unwrap();
        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0].tool_call_id, "call_1");
        assert_eq!(decisions[0].fingerprint, "fp_123");
        assert_eq!(decisions[0].decision, PermissionDecisionKind::AllowAlways);
    }

    #[test]
    fn upserts_and_retrieves_pending_request() {
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn.lock();
        let repo = PermissionRepository::new(&conn);
        let request = create_test_pending_request();

        repo.upsert_pending(&request).unwrap();

        let retrieved = repo.get_pending_by_tool_call("conv_1", "call_1").unwrap();
        assert!(retrieved.is_some());
        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.tool_call_id, "call_1");
        assert_eq!(retrieved.status, PendingPermissionStatus::Pending);
    }

    #[test]
    fn updates_pending_status() {
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn.lock();
        let repo = PermissionRepository::new(&conn);
        let request = create_test_pending_request();

        repo.upsert_pending(&request).unwrap();
        repo.update_pending_status(&request.id, PendingPermissionStatus::Resolved).unwrap();

        let retrieved = repo.get_pending_by_tool_call("conv_1", "call_1").unwrap().unwrap();
        assert_eq!(retrieved.status, PendingPermissionStatus::Resolved);
        assert!(retrieved.resolved_at.is_some());
    }

    #[test]
    fn lists_pending_requests() {
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn.lock();
        let repo = PermissionRepository::new(&conn);

        let request1 = create_test_pending_request();
        let request2 = PendingPermissionRequest {
            id: "req_2".to_string(),
            conversation_id: "conv_1".to_string(),
            turn_id: "turn_1".to_string(),
            tool_call_id: "call_2".to_string(),
            fingerprint: "fp_456".to_string(),
            options_json: json!([{"optionId": "reject", "kind": "reject_once"}]),
            status: PendingPermissionStatus::Pending,
            created_at: chrono::Utc::now(),
            resolved_at: None,
        };

        repo.upsert_pending(&request1).unwrap();
        repo.upsert_pending(&request2).unwrap();

        let pending = repo.list_pending("conv_1").unwrap();
        assert_eq!(pending.len(), 2);
    }

    #[test]
    fn cancels_pending_for_turn() {
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn.lock();
        let repo = PermissionRepository::new(&conn);

        let request1 = create_test_pending_request();
        let request2 = PendingPermissionRequest {
            id: "req_2".to_string(),
            conversation_id: "conv_1".to_string(),
            turn_id: "turn_2".to_string(),
            tool_call_id: "call_2".to_string(),
            fingerprint: "fp_456".to_string(),
            options_json: json!([{"optionId": "allow", "kind": "allow_once"}]),
            status: PendingPermissionStatus::Resolved, // Already resolved
            created_at: chrono::Utc::now(),
            resolved_at: Some(chrono::Utc::now()),
        };

        repo.upsert_pending(&request1).unwrap();
        repo.upsert_pending(&request2).unwrap();

        repo.cancel_pending_for_turn("conv_1").unwrap();

        let pending = repo.list_pending("conv_1").unwrap();
        // Should only have the pending one, now cancelled
        let cancelled: Vec<_> = pending.iter().filter(|p| p.status == PendingPermissionStatus::Cancelled).collect();
        assert_eq!(cancelled.len(), 1);
    }

    #[test]
    fn stores_different_decision_kinds() {
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn.lock();
        let repo = PermissionRepository::new(&conn);

        let kinds = vec![
            PermissionDecisionKind::AllowOnce,
            PermissionDecisionKind::AllowAlways,
            PermissionDecisionKind::RejectOnce,
            PermissionDecisionKind::RejectAlways,
        ];

        for (i, kind) in kinds.iter().enumerate() {
            let decision = PermissionDecision {
                id: format!("dec_{}", i),
                conversation_id: "conv_1".to_string(),
                tool_call_id: format!("call_{}", i),
                scope: "session".to_string(),
                fingerprint: format!("fp_{}", i),
                decision: kind.clone(),
                created_at: chrono::Utc::now(),
            };
            repo.record_decision(&decision).unwrap();
        }

        let decisions = repo.list_decisions("conv_1").unwrap();
        assert_eq!(decisions.len(), 4);
    }
}
