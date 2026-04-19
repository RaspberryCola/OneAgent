use std::sync::Arc;

use crate::{
    domain::{PermissionDecision, PermissionDecisionKind},
    runtime::Runtime,
};

use super::ApplicationResult;

#[derive(Clone)]
pub struct PermissionAppService {
    runtime: Arc<Runtime>,
}

impl PermissionAppService {
    pub fn new(runtime: Arc<Runtime>) -> Self {
        Self { runtime }
    }

    pub fn list_permissions(
        &self,
        conversation_id: &str,
    ) -> ApplicationResult<Vec<PermissionDecision>> {
        Ok(self.runtime.list_permissions(conversation_id)?)
    }

    pub async fn resolve_permission_request(
        &self,
        conversation_id: &str,
        tool_call_id: &str,
        fingerprint: &str,
        decision: PermissionDecisionKind,
    ) -> ApplicationResult<PermissionDecision> {
        Ok(self
            .runtime
            .resolve_permission_request(conversation_id, tool_call_id, fingerprint, decision)
            .await?)
    }
}
