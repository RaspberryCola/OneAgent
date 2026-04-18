use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

use crate::runtime::{ManagedSession, Runtime, RuntimeResult};
use crate::domain::{PendingPermissionRequest, PendingPermissionStatus};
use crate::capability_services::policy::PolicyEngine;

impl Runtime {
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn project_permission_request(
        &self,
        conversation_id: &str,
        turn_id: &str,
        tool_call_id: String,
        tool_kind: String,
        title: String,
        raw_input: serde_json::Value,
        paths: Vec<String>,
        options: serde_json::Value,
    ) -> RuntimeResult<()> {
        self.finalize_thinking_stream(conversation_id, turn_id)?;
        let fingerprint = PolicyEngine::fingerprint(&tool_kind, &title, &raw_input, &paths);
        if let Some(decision) = self
            .policy_engine
            .find_session_policy(conversation_id, &fingerprint)?
        {
            let managed_session = self.session_manager.get(conversation_id);
            if let Some(ManagedSession::Acp(session)) = managed_session {
                session
                    .resolve_permission(&tool_call_id, decision.decision.clone())
                    .await?;
            }
            self.emit(
                "conversation:permission_resolved",
                &json!({ "conversation_id": conversation_id, "decision": decision }),
            );
        } else {
            let request = PendingPermissionRequest {
                id: Uuid::new_v4().to_string(),
                conversation_id: conversation_id.to_string(),
                turn_id: turn_id.to_string(),
                tool_call_id: tool_call_id.clone(),
                fingerprint: fingerprint.clone(),
                options_json: options.clone(),
                status: PendingPermissionStatus::Pending,
                created_at: Utc::now(),
                resolved_at: None,
            };
            self.db.upsert_pending_permission(&request)?;
            self.record_lifecycle_event(
                conversation_id,
                "PermissionRequested",
                json!({
                    "request_id": request.id,
                    "tool_call_id": tool_call_id,
                    "tool_kind": tool_kind,
                    "title": title,
                    "paths": paths,
                    "fingerprint": fingerprint,
                    "options": options
                }),
            )?;
            self.emit(
                "conversation:permission_requested",
                &json!({
                    "conversation_id": conversation_id,
                    "request": {
                        "id": request.id,
                        "conversation_id": conversation_id,
                        "turn_id": turn_id,
                        "tool_call_id": tool_call_id,
                        "fingerprint": fingerprint,
                        "options_json": options,
                        "status": "pending",
                        "created_at": request.created_at,
                        "resolved_at": serde_json::Value::Null
                    }
                }),
            );
        }
        Ok(())
    }
}
