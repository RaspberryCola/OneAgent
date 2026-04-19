use async_trait::async_trait;

use crate::{
    agent_adapters::{
        AdapterError, AdapterResult, AgentAdapter, AgentSessionHandle, LoadedSession,
        RuntimeStreamEvent,
    },
    domain::{
        AgentCapabilities, AgentProfile, AttachmentInput, AttachmentKind, ExternalSession,
        McpServerConfig,
    },
};

#[derive(Default)]
pub struct CompatAdapter;

fn build_fallback_text_path_prompt(input: &str, attachments: &[AttachmentInput]) -> String {
    if attachments.is_empty() {
        return input.to_string();
    }
    let mut out = input.to_string();
    for attachment in attachments {
        let mime_type = attachment
            .mime_type
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("application/octet-stream");
        let kind = match attachment.kind {
            AttachmentKind::Image => "image",
            AttachmentKind::Audio => "audio",
            AttachmentKind::File => "file",
        };
        out.push_str("\n\n[Attached file]\n");
        out.push_str(&format!("name: {}\n", attachment.name));
        out.push_str(&format!("kind: {kind}\n"));
        out.push_str(&format!("path: {}\n", attachment.path));
        out.push_str(&format!("mime_type: {mime_type}"));
    }
    out
}

#[async_trait]
impl AgentAdapter for CompatAdapter {
    async fn initialize(&self, _profile: &AgentProfile) -> AdapterResult<AgentCapabilities> {
        Err(AdapterError::Protocol(
            "compat adapters are not implemented in v1".to_string(),
        ))
    }

    async fn list_sessions(
        &self,
        _profile: &AgentProfile,
        _cwd: Option<&str>,
    ) -> AdapterResult<Vec<ExternalSession>> {
        Ok(Vec::new())
    }

    async fn new_session(
        &self,
        _profile: &AgentProfile,
        _cwd: &str,
        _mcp_servers: &[McpServerConfig],
    ) -> AdapterResult<AgentSessionHandle> {
        Err(AdapterError::Protocol(
            "compat adapters are not implemented in v1".to_string(),
        ))
    }

    async fn load_session(
        &self,
        _profile: &AgentProfile,
        _remote_session_id: &str,
        _cwd: &str,
        _mcp_servers: &[McpServerConfig],
    ) -> AdapterResult<LoadedSession> {
        Err(AdapterError::Protocol(
            "compat adapters are not implemented in v1".to_string(),
        ))
    }

    async fn prompt(
        &self,
        _profile: &AgentProfile,
        _handle: &AgentSessionHandle,
        input: &str,
        attachments: &[AttachmentInput],
    ) -> AdapterResult<Vec<RuntimeStreamEvent>> {
        let _fallback_prompt = build_fallback_text_path_prompt(input, attachments);
        Err(AdapterError::Protocol(
            "compat adapters are not implemented in v1".to_string(),
        ))
    }

    async fn cancel(
        &self,
        _profile: &AgentProfile,
        _handle: &AgentSessionHandle,
    ) -> AdapterResult<()> {
        Ok(())
    }

    async fn set_config_option(
        &self,
        _profile: &AgentProfile,
        _handle: &AgentSessionHandle,
        _config_id: &str,
        _value: &serde_json::Value,
    ) -> AdapterResult<Vec<crate::domain::SessionConfigOption>> {
        Ok(Vec::new())
    }

    async fn close(
        &self,
        _profile: &AgentProfile,
        _handle: &AgentSessionHandle,
    ) -> AdapterResult<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::domain::{AttachmentDeliveryPreference, AttachmentUsageIntent};

    use super::*;

    #[test]
    fn fallback_template_appends_attachment_metadata() {
        let text = build_fallback_text_path_prompt(
            "Please process this file",
            &[AttachmentInput {
                id: "a1".to_string(),
                name: "report.pdf".to_string(),
                path: "/tmp/report.pdf".to_string(),
                mime_type: Some("application/pdf".to_string()),
                kind: AttachmentKind::File,
                usage_intent: AttachmentUsageIntent::FileResource,
                delivery_preference: AttachmentDeliveryPreference::Auto,
            }],
        );

        assert!(text.contains("Please process this file"));
        assert!(text.contains("[Attached file]"));
        assert!(text.contains("name: report.pdf"));
        assert!(text.contains("path: /tmp/report.pdf"));
        assert!(text.contains("mime_type: application/pdf"));
    }
}
