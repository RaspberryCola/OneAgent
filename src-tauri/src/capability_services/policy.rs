use chrono::Utc;
use serde_json::Value;
use uuid::Uuid;

use crate::{
    domain::{PermissionDecision, PermissionDecisionKind},
    storage::{Database, StorageResult},
};

#[derive(Clone)]
pub struct PolicyEngine {
    db: Database,
}

impl PolicyEngine {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    pub fn fingerprint(
        tool_kind: &str,
        title: &str,
        raw_input: &Value,
        paths: &[String],
    ) -> String {
        let normalized = serde_json::json!({
            "tool_kind": tool_kind,
            "title": title,
            "raw_input": raw_input,
            "paths": paths,
        });
        normalized.to_string()
    }

    pub fn find_session_policy(
        &self,
        conversation_id: &str,
        fingerprint: &str,
    ) -> StorageResult<Option<PermissionDecision>> {
        Ok(self
            .db
            .list_permissions(conversation_id)?
            .into_iter()
            .find(|decision| {
                decision.fingerprint == fingerprint
                    && matches!(
                        decision.decision,
                        PermissionDecisionKind::AllowAlways | PermissionDecisionKind::RejectAlways
                    )
            }))
    }

    pub fn record_decision(
        &self,
        conversation_id: &str,
        tool_call_id: &str,
        fingerprint: &str,
        decision: PermissionDecisionKind,
    ) -> StorageResult<PermissionDecision> {
        let entry = PermissionDecision {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            tool_call_id: tool_call_id.to_string(),
            scope: "session".to_string(),
            fingerprint: fingerprint.to_string(),
            decision,
            created_at: Utc::now(),
        };
        self.db.record_permission_decision(&entry)?;
        Ok(entry)
    }
}

#[cfg(test)]
mod tests {
    use super::PolicyEngine;
    use crate::domain::PermissionDecisionKind;
    use crate::storage::sqlite::connection::Database;
    use chrono::Utc;
    use serde_json::json;

    #[test]
    fn fingerprint_is_stable_for_identical_inputs() {
        let left = PolicyEngine::fingerprint(
            "write_file",
            "write output",
            &json!({ "path": "/tmp/demo.txt" }),
            &["/tmp/demo.txt".to_string()],
        );
        let right = PolicyEngine::fingerprint(
            "write_file",
            "write output",
            &json!({ "path": "/tmp/demo.txt" }),
            &["/tmp/demo.txt".to_string()],
        );
        assert_eq!(left, right);
    }

    #[test]
    fn fingerprint_changes_with_different_inputs() {
        let fp1 = PolicyEngine::fingerprint(
            "write_file",
            "write output",
            &json!({ "path": "/tmp/demo.txt" }),
            &["/tmp/demo.txt".to_string()],
        );
        let fp2 = PolicyEngine::fingerprint(
            "write_file",
            "write output",
            &json!({ "path": "/tmp/other.txt" }), // Different path
            &["/tmp/other.txt".to_string()],
        );
        let fp3 = PolicyEngine::fingerprint(
            "read_file", // Different tool kind
            "read output",
            &json!({ "path": "/tmp/demo.txt" }),
            &["/tmp/demo.txt".to_string()],
        );
        assert_ne!(fp1, fp2);
        assert_ne!(fp1, fp3);
    }

    #[test]
    fn find_session_policy_returns_allow_always_match() {
        let db = Database::new_in_memory().unwrap();
        let policy = PolicyEngine::new(db);

        let decision = crate::domain::PermissionDecision {
            id: "dec_1".to_string(),
            conversation_id: "conv_1".to_string(),
            tool_call_id: "call_1".to_string(),
            scope: "session".to_string(),
            fingerprint: PolicyEngine::fingerprint(
                "write_file",
                "Write file",
                &json!({}),
                &[],
            ),
            decision: PermissionDecisionKind::AllowAlways,
            created_at: Utc::now(),
        };

        policy.record_decision(
            &decision.conversation_id,
            &decision.tool_call_id,
            &decision.fingerprint,
            decision.decision.clone(),
        ).unwrap();

        let found = policy.find_session_policy("conv_1", &decision.fingerprint).unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().decision, PermissionDecisionKind::AllowAlways);
    }

    #[test]
    fn find_session_policy_returns_reject_always_match() {
        let db = Database::new_in_memory().unwrap();
        let policy = PolicyEngine::new(db);

        let fingerprint = PolicyEngine::fingerprint(
            "execute_command",
            "Run command",
            &json!({}),
            &[],
        );

        policy.record_decision("conv_1", "call_1", &fingerprint, PermissionDecisionKind::RejectAlways).unwrap();

        let found = policy.find_session_policy("conv_1", &fingerprint).unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().decision, PermissionDecisionKind::RejectAlways);
    }

    #[test]
    fn find_session_policy_skips_once_decisions() {
        let db = Database::new_in_memory().unwrap();
        let policy = PolicyEngine::new(db);

        let fingerprint = PolicyEngine::fingerprint(
            "write_file",
            "Write file",
            &json!({}),
            &[],
        );

        // Record AllowOnce - should NOT match for auto-hit
        policy.record_decision("conv_1", "call_1", &fingerprint, PermissionDecisionKind::AllowOnce).unwrap();

        let found = policy.find_session_policy("conv_1", &fingerprint).unwrap();
        assert!(found.is_none());

        // Record RejectOnce - should NOT match for auto-hit
        policy.record_decision("conv_1", "call_2", &fingerprint, PermissionDecisionKind::RejectOnce).unwrap();

        let found = policy.find_session_policy("conv_1", &fingerprint).unwrap();
        assert!(found.is_none());
    }

    #[test]
    fn find_session_policy_only_matches_same_conversation() {
        let db = Database::new_in_memory().unwrap();
        let policy = PolicyEngine::new(db);

        let fingerprint = PolicyEngine::fingerprint(
            "write_file",
            "Write file",
            &json!({}),
            &[],
        );

        policy.record_decision("conv_1", "call_1", &fingerprint, PermissionDecisionKind::AllowAlways).unwrap();

        // Should not match in different conversation
        let found = policy.find_session_policy("conv_2", &fingerprint).unwrap();
        assert!(found.is_none());
    }

    #[test]
    fn record_decision_creates_permission_entry() {
        let db = Database::new_in_memory().unwrap();
        let policy = PolicyEngine::new(db);

        let decision = policy.record_decision(
            "conv_1",
            "call_1",
            "fp_123",
            PermissionDecisionKind::AllowAlways,
        ).unwrap();

        assert_eq!(decision.conversation_id, "conv_1");
        assert_eq!(decision.tool_call_id, "call_1");
        assert_eq!(decision.fingerprint, "fp_123");
        assert_eq!(decision.decision, PermissionDecisionKind::AllowAlways);
        assert_eq!(decision.scope, "session");
    }
}
