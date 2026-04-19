//! ACP adapter implementation.
//!
//! This module provides the main `AgentAdapter` trait implementation for the
//! ACP (Agent Client Protocol) protocol.

use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::time::timeout;
use uuid::Uuid;

use crate::{
    agent_adapters::{
        AdapterError, AdapterResult, AgentAdapter, AgentSessionHandle, LoadedSession,
        RuntimeStreamEvent,
    },
    domain::{
        AgentCapabilities, AgentProfile, AttachmentInput, ExternalSession, McpServerConfig,
        SessionConfigOption,
    },
};

use super::live_session::AcpLiveSession;
use super::parser::{
    jsonrpc_error_message, parse_agent_capabilities, parse_config_options,
    parse_session_capabilities, parse_session_update,
};
use super::permission::parse_permission_request;
use super::process::JsonRpcProcess;
use super::prompt_codec::build_prompt_blocks_from_message;

/// ACP adapter for Agent Client Protocol agents.
#[derive(Default)]
pub struct AcpAdapter;

#[async_trait]
impl AgentAdapter for AcpAdapter {
    async fn initialize(&self, profile: &AgentProfile) -> AdapterResult<AgentCapabilities> {
        let mut process = JsonRpcProcess::spawn(profile).await?;
        let response = process.initialize().await?;
        process.close().await?;
        Ok(parse_agent_capabilities(&response))
    }

    async fn list_sessions(
        &self,
        profile: &AgentProfile,
        cwd: Option<&str>,
    ) -> AdapterResult<Vec<ExternalSession>> {
        let mut process = JsonRpcProcess::spawn(profile).await?;
        let capabilities = process.initialize().await?;
        if !parse_session_capabilities(
            &capabilities
                .get("result")
                .cloned()
                .unwrap_or_else(|| json!({})),
        )
        .list
        {
            process.close().await?;
            return Ok(Vec::new());
        }
        let mut params = serde_json::Map::new();
        if let Some(cwd) = cwd {
            params.insert("cwd".to_string(), json!(cwd));
        }
        let response = process
            .request("session/list", Value::Object(params))
            .await?;
        process.close().await?;
        Ok(response
            .get("result")
            .and_then(|r| r.get("sessions"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|session| ExternalSession {
                remote_session_id: session
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                cwd: session
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                title: session
                    .get("title")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                updated_at: session
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            })
            .collect())
    }

    async fn new_session(
        &self,
        profile: &AgentProfile,
        cwd: &str,
        mcp_servers: &[McpServerConfig],
    ) -> AdapterResult<AgentSessionHandle> {
        // Use AcpLiveSession::start_new for creating a live session
        let session = AcpLiveSession::start_new(profile, cwd, mcp_servers).await?;
        Ok(session.handle)
    }

    async fn load_session(
        &self,
        profile: &AgentProfile,
        remote_session_id: &str,
        cwd: &str,
        mcp_servers: &[McpServerConfig],
    ) -> AdapterResult<LoadedSession> {
        // Use AcpLiveSession::start_loaded for loading a session
        let (session, replay_events) =
            AcpLiveSession::start_loaded(profile, remote_session_id, cwd, mcp_servers).await?;
        Ok(LoadedSession {
            handle: session.handle,
            replay_events,
        })
    }

    async fn prompt(
        &self,
        profile: &AgentProfile,
        handle: &AgentSessionHandle,
        input: &str,
        attachments: &[AttachmentInput],
    ) -> AdapterResult<Vec<RuntimeStreamEvent>> {
        // This is a legacy/simplified prompt mode that returns all events at once
        // without streaming. For proper streaming, use AcpLiveSession::run_turn.
        let mut process = JsonRpcProcess::spawn(profile).await?;
        process.set_session_cwd(&handle.cwd);
        let initialize_response = process.initialize().await?;
        let capabilities = parse_agent_capabilities(&initialize_response);
        process
            .request(
                "session/load",
                json!({
                    "sessionId": handle.remote_session_id,
                    "cwd": handle.cwd,
                    "mcpServers": []
                }),
            )
            .await?;
        let turn_id = Uuid::new_v4().to_string();
        let request_id = process.next_id();
        let prompt =
            build_prompt_blocks_from_message(input, attachments, &capabilities.prompt_capabilities)
                .await?;
        process
            .write_message(json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "session/prompt",
                "params": {
                    "sessionId": handle.remote_session_id,
                    "prompt": prompt
                }
            }))
            .await?;

        let mut events = vec![RuntimeStreamEvent::StateChanged {
            status: "running".to_string(),
        }];
        for _ in 0..256 {
            match timeout(Duration::from_secs(30), process.read_message()).await {
                Ok(Ok(message)) => {
                    if let Some(method) = message.get("method").and_then(Value::as_str) {
                        if method == "session/update" {
                            events.extend(parse_session_update(&message, &turn_id));
                            continue;
                        }
                        if method == "session/request_permission" {
                            if let Some((permission_event, permission_id, _options)) =
                                parse_permission_request(&message, &turn_id)
                            {
                                events.push(permission_event);
                                process
                                    .write_message(json!({
                                        "jsonrpc": "2.0",
                                        "id": permission_id,
                                        "result": {
                                            "outcome": {
                                                "outcome": "cancelled"
                                            }
                                        }
                                    }))
                                    .await?;
                                events.push(RuntimeStreamEvent::Error {
                                    message: "permission request requires interactive client response; automatically cancelled in current backend mode".to_string(),
                                });
                                break;
                            }
                        }
                        process.handle_client_request(&message).await?;
                        continue;
                    }
                    if message.get("id").and_then(Value::as_i64) == Some(request_id) {
                        if let Some(error_message) = jsonrpc_error_message(&message) {
                            process.clear_turn();
                            return Err(AdapterError::Protocol(format!(
                                "session/prompt failed: {error_message}"
                            )));
                        }
                        if let Some(stop_reason) = message
                            .get("result")
                            .and_then(|r| r.get("stopReason"))
                            .and_then(Value::as_str)
                        {
                            events.push(RuntimeStreamEvent::StateChanged {
                                status: stop_reason.to_string(),
                            });
                        }
                        break;
                    }
                }
                Ok(Err(err)) => {
                    events.push(RuntimeStreamEvent::Error {
                        message: err.to_string(),
                    });
                    break;
                }
                Err(_) => break,
            }
        }
        events.push(RuntimeStreamEvent::TurnFinished { turn_id });
        process.close().await?;
        Ok(events)
    }

    async fn cancel(
        &self,
        profile: &AgentProfile,
        handle: &AgentSessionHandle,
    ) -> AdapterResult<()> {
        let mut process = JsonRpcProcess::spawn(profile).await?;
        process.set_session_cwd(&handle.cwd);
        process.initialize().await?;
        process
            .request(
                "session/cancel",
                json!({
                    "sessionId": handle.remote_session_id
                }),
            )
            .await?;
        process.close().await?;
        Ok(())
    }

    async fn set_config_option(
        &self,
        profile: &AgentProfile,
        handle: &AgentSessionHandle,
        config_id: &str,
        value: &Value,
    ) -> AdapterResult<Vec<SessionConfigOption>> {
        let mut process = JsonRpcProcess::spawn(profile).await?;
        process.set_session_cwd(&handle.cwd);
        process.initialize().await?;
        let response = process
            .request(
                "session/set_config_option",
                json!({
                    "sessionId": handle.remote_session_id,
                    "configId": config_id,
                    "value": value
                }),
            )
            .await?;
        process.close().await?;
        Ok(parse_config_options(response.get("result")))
    }

    async fn close(
        &self,
        _profile: &AgentProfile,
        _handle: &AgentSessionHandle,
    ) -> AdapterResult<()> {
        // No persistent state to close in the adapter itself
        Ok(())
    }
}
