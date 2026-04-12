use async_trait::async_trait;

use crate::{
    agent_adapters::{AdapterError, AdapterResult, AgentAdapter, AgentSessionHandle, LoadedSession, RuntimeStreamEvent},
    domain::{AgentCapabilities, AgentProfile, AttachmentInput, ExternalSession, McpServerConfig},
};

#[derive(Default)]
pub struct CompatAdapter;

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
        _input: &str,
        _attachments: &[AttachmentInput],
    ) -> AdapterResult<Vec<RuntimeStreamEvent>> {
        Err(AdapterError::Protocol(
            "compat adapters are not implemented in v1".to_string(),
        ))
    }

    async fn cancel(&self, _profile: &AgentProfile, _handle: &AgentSessionHandle) -> AdapterResult<()> {
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

    async fn close(&self, _profile: &AgentProfile, _handle: &AgentSessionHandle) -> AdapterResult<()> {
        Ok(())
    }
}
