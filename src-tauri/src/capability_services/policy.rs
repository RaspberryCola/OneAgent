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

    pub fn fingerprint(tool_kind: &str, title: &str, raw_input: &Value, paths: &[String]) -> String {
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
}
