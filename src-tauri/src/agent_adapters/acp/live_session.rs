//! ACP live session management.
//!
//! This module handles live ACP sessions including session lifecycle,
//! turn execution, and actor loop for handling streaming events.

use std::collections::HashMap;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::{
    agent_adapters::{AdapterError, AdapterResult, AgentSessionHandle, RuntimeStreamEvent},
    domain::{
        AcpSessionModeState, AcpSessionModels, AgentProfile, AttachmentInput, McpServerConfig,
        PermissionDecisionKind, SessionConfigOption,
    },
};

use super::parser::{
    jsonrpc_error_message, parse_config_options, parse_models, parse_modes,
    parse_prompt_capabilities, parse_session_capabilities, parse_session_update,
};
use super::permission::{
    parse_permission_request, send_cancelled_permission, send_permission_decision,
};
use super::process::JsonRpcProcess;
use super::prompt_codec::build_prompt_blocks_from_message;

/// A permission option offered by the agent.
#[derive(Debug, Clone)]
pub(crate) struct PermissionOption {
    pub(crate) option_id: String,
    pub(crate) kind: String,
}

/// A pending permission request awaiting user decision.
#[derive(Debug, Clone)]
struct PendingPermission {
    request_id: i64,
    options: Vec<PermissionOption>,
}

/// Commands sent to the live session actor.
#[derive(Debug)]
pub(crate) enum LiveSessionCommand {
    RunTurn {
        prompt: Vec<Value>,
        event_tx: mpsc::UnboundedSender<RuntimeStreamEvent>,
        completion_tx: oneshot::Sender<AdapterResult<()>>,
    },
    ResolvePermission {
        tool_call_id: String,
        decision: PermissionDecisionKind,
        resp: oneshot::Sender<AdapterResult<()>>,
    },
    Cancel {
        resp: oneshot::Sender<AdapterResult<()>>,
    },
    SetConfig {
        config_id: String,
        value: Value,
        resp: oneshot::Sender<AdapterResult<Vec<SessionConfigOption>>>,
    },
    SetModel {
        model_id: String,
        resp: oneshot::Sender<AdapterResult<AcpSessionModels>>,
    },
    SetMode {
        mode_id: String,
        resp: oneshot::Sender<AdapterResult<AcpSessionModeState>>,
    },
    Close,
}

/// A live ACP session handle with command channel.
#[derive(Clone)]
pub struct AcpLiveSession {
    command_tx: mpsc::UnboundedSender<LiveSessionCommand>,
    pub handle: AgentSessionHandle,
}

impl AcpLiveSession {
    /// Start a new ACP session.
    pub async fn start_new(
        profile: &AgentProfile,
        cwd: &str,
        mcp_servers: &[McpServerConfig],
    ) -> AdapterResult<Self> {
        let mut process = JsonRpcProcess::spawn(profile).await?;
        process.set_session_cwd(cwd);
        let initialize_response = process.initialize().await?;
        let capabilities = parse_session_capabilities(
            &initialize_response
                .get("result")
                .cloned()
                .unwrap_or_else(|| json!({})),
        );
        let response = process
            .request(
                "session/new",
                json!({
                    "cwd": cwd,
                    "mcpServers": mcp_servers,
                }),
            )
            .await?;
        let fallback_session_id = Uuid::new_v4().to_string();
        let handle = AgentSessionHandle {
            adapter_kind: "acp".to_string(),
            remote_session_id: response
                .get("result")
                .and_then(|v| v.get("sessionId"))
                .and_then(Value::as_str)
                .unwrap_or(&fallback_session_id)
                .to_string(),
            cwd: cwd.to_string(),
            load_supported: capabilities.load,
            prompt_capabilities: parse_prompt_capabilities(
                &initialize_response
                    .get("result")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            ),
            config_options: parse_config_options(response.get("result")),
            models: parse_models(response.get("result")),
            modes: parse_modes(response.get("result")),
        };
        Ok(spawn_live_actor(process, handle))
    }

    /// Load an existing ACP session.
    pub async fn start_loaded(
        profile: &AgentProfile,
        remote_session_id: &str,
        cwd: &str,
        mcp_servers: &[McpServerConfig],
    ) -> AdapterResult<(Self, Vec<RuntimeStreamEvent>)> {
        let mut process = JsonRpcProcess::spawn(profile).await?;
        process.set_session_cwd(cwd);
        let initialize_response = process.initialize().await?;
        let capabilities = parse_session_capabilities(
            &initialize_response
                .get("result")
                .cloned()
                .unwrap_or_else(|| json!({})),
        );
        // Note: we do NOT gate on capabilities.load here.  Some agents
        // successfully handle session/load without advertising it in their
        // capabilities.  If the agent truly does not support it, the
        // session/load JSON-RPC call below will return an error which we
        // propagate to the caller.
        let request_id = process.next_id();
        process
            .write_message(json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "session/load",
                "params": {
                    "sessionId": remote_session_id,
                    "cwd": cwd,
                    "mcpServers": mcp_servers
                }
            }))
            .await?;
        let mut replay_events = Vec::new();
        let response_result = loop {
            let message = process.read_message().await?;
            if let Some(method) = message.get("method").and_then(Value::as_str) {
                if method == "session/update" {
                    replay_events.extend(parse_session_update(&message, "history"));
                    continue;
                }
                process.handle_client_request(&message).await?;
                continue;
            }
            if message.get("id").and_then(Value::as_i64) == Some(request_id) {
                if let Some(error_message) = jsonrpc_error_message(&message) {
                    process.close().await?;
                    return Err(AdapterError::Protocol(format!(
                        "session/load failed: {error_message}"
                    )));
                }
                break message.get("result").cloned();
            }
        };
        let handle = AgentSessionHandle {
            adapter_kind: "acp".to_string(),
            remote_session_id: remote_session_id.to_string(),
            cwd: cwd.to_string(),
            load_supported: capabilities.load,
            prompt_capabilities: parse_prompt_capabilities(
                &initialize_response
                    .get("result")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            ),
            config_options: parse_config_options(response_result.as_ref()),
            models: parse_models(response_result.as_ref()),
            modes: parse_modes(response_result.as_ref()),
        };
        Ok((spawn_live_actor(process, handle), replay_events))
    }

    /// Run a prompt turn with the given input and attachments.
    pub async fn run_turn(
        &self,
        input: &str,
        attachments: &[AttachmentInput],
    ) -> AdapterResult<(
        mpsc::UnboundedReceiver<RuntimeStreamEvent>,
        oneshot::Receiver<AdapterResult<()>>,
    )> {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (completion_tx, completion_rx) = oneshot::channel();
        self.command_tx
            .send(LiveSessionCommand::RunTurn {
                prompt: build_prompt_blocks_from_message(
                    input,
                    attachments,
                    &self.handle.prompt_capabilities,
                )
                .await?,
                event_tx,
                completion_tx,
            })
            .map_err(|_| AdapterError::Protocol("live ACP session stopped".to_string()))?;
        Ok((event_rx, completion_rx))
    }

    /// Resolve a pending permission request.
    pub async fn resolve_permission(
        &self,
        tool_call_id: &str,
        decision: PermissionDecisionKind,
    ) -> AdapterResult<()> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.command_tx
            .send(LiveSessionCommand::ResolvePermission {
                tool_call_id: tool_call_id.to_string(),
                decision,
                resp: resp_tx,
            })
            .map_err(|_| AdapterError::Protocol("live ACP session stopped".to_string()))?;
        resp_rx
            .await
            .map_err(|_| AdapterError::Protocol("permission response dropped".to_string()))?
    }

    /// Cancel the current turn.
    pub async fn cancel(&self) -> AdapterResult<()> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.command_tx
            .send(LiveSessionCommand::Cancel { resp: resp_tx })
            .map_err(|_| AdapterError::Protocol("live ACP session stopped".to_string()))?;
        resp_rx
            .await
            .map_err(|_| AdapterError::Protocol("cancel response dropped".to_string()))?
    }

    /// Set a configuration option.
    pub async fn set_config_option(
        &self,
        config_id: &str,
        value: &Value,
    ) -> AdapterResult<Vec<SessionConfigOption>> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.command_tx
            .send(LiveSessionCommand::SetConfig {
                config_id: config_id.to_string(),
                value: value.clone(),
                resp: resp_tx,
            })
            .map_err(|_| AdapterError::Protocol("live ACP session stopped".to_string()))?;
        resp_rx
            .await
            .map_err(|_| AdapterError::Protocol("set config response dropped".to_string()))?
    }

    /// Set the active model.
    pub async fn set_model(&self, model_id: &str) -> AdapterResult<AcpSessionModels> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.command_tx
            .send(LiveSessionCommand::SetModel {
                model_id: model_id.to_string(),
                resp: resp_tx,
            })
            .map_err(|_| AdapterError::Protocol("live ACP session stopped".to_string()))?;
        resp_rx
            .await
            .map_err(|_| AdapterError::Protocol("set model response dropped".to_string()))?
    }

    /// Set the active mode.
    pub async fn set_mode(&self, mode_id: &str) -> AdapterResult<AcpSessionModeState> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.command_tx
            .send(LiveSessionCommand::SetMode {
                mode_id: mode_id.to_string(),
                resp: resp_tx,
            })
            .map_err(|_| AdapterError::Protocol("live ACP session stopped".to_string()))?;
        resp_rx
            .await
            .map_err(|_| AdapterError::Protocol("set mode response dropped".to_string()))?
    }

    /// Close the session.
    pub fn close(&self) {
        let _ = self.command_tx.send(LiveSessionCommand::Close);
    }
}

// Actor functions (spawn_live_actor and run_turn_loop)

fn spawn_live_actor(process: JsonRpcProcess, handle: AgentSessionHandle) -> AcpLiveSession {
    let (command_tx, mut command_rx) = mpsc::unbounded_channel();
    let live_handle = handle.clone();
    tokio::spawn(async move {
        let mut process = process;
        while let Some(command) = command_rx.recv().await {
            match command {
                LiveSessionCommand::RunTurn {
                    prompt,
                    event_tx,
                    completion_tx,
                } => {
                    let result = run_turn_loop(
                        &mut process,
                        &live_handle,
                        prompt,
                        &event_tx,
                        &mut command_rx,
                    )
                    .await;
                    let _ = completion_tx.send(result);
                }
                LiveSessionCommand::ResolvePermission { resp, .. } => {
                    let _ = resp.send(Err(AdapterError::Protocol(
                        "no prompt turn is currently awaiting permission".to_string(),
                    )));
                }
                LiveSessionCommand::Cancel { resp } => {
                    let result = process
                        .write_message(json!({
                            "jsonrpc": "2.0",
                            "method": "session/cancel",
                            "params": {
                                "sessionId": live_handle.remote_session_id
                            }
                        }))
                        .await;
                    let _ = resp.send(result);
                }
                LiveSessionCommand::SetConfig {
                    config_id,
                    value,
                    resp,
                } => {
                    let result = process
                        .request(
                            "session/set_config_option",
                            json!({
                                "sessionId": live_handle.remote_session_id,
                                "configId": config_id,
                                "value": value
                            }),
                        )
                        .await
                        .map(|response| parse_config_options(response.get("result")));
                    let _ = resp.send(result);
                }
                LiveSessionCommand::SetModel { model_id, resp } => {
                    let result = process
                        .request(
                            "session/set_model",
                            json!({
                                "sessionId": live_handle.remote_session_id,
                                "modelId": model_id
                            }),
                        )
                        .await
                        .map(|response| {
                            // Try to get models from response, otherwise construct from local state
                            let models_from_response = parse_models(response.get("result"));
                            models_from_response.unwrap_or_else(|| AcpSessionModels {
                                current_model_id: Some(model_id.clone()),
                                available_models: live_handle
                                    .models
                                    .clone()
                                    .and_then(|m| m.available_models),
                            })
                        });
                    let _ = resp.send(result);
                }
                LiveSessionCommand::SetMode { mode_id, resp } => {
                    let result = process
                        .request(
                            "session/set_mode",
                            json!({
                                "sessionId": live_handle.remote_session_id,
                                "modeId": mode_id
                            }),
                        )
                        .await
                        .map(|response| {
                            let modes_from_response = parse_modes(response.get("result"));
                            modes_from_response.unwrap_or_else(|| AcpSessionModeState {
                                current_mode_id: mode_id.clone(),
                                available_modes: live_handle
                                    .modes
                                    .clone()
                                    .map(|m| m.available_modes)
                                    .unwrap_or_default(),
                            })
                        });
                    let _ = resp.send(result);
                }
                LiveSessionCommand::Close => {
                    let _ = process.close().await;
                    break;
                }
            }
        }
    });
    AcpLiveSession { command_tx, handle }
}

async fn run_turn_loop(
    process: &mut JsonRpcProcess,
    handle: &AgentSessionHandle,
    prompt: Vec<Value>,
    event_tx: &mpsc::UnboundedSender<RuntimeStreamEvent>,
    command_rx: &mut mpsc::UnboundedReceiver<LiveSessionCommand>,
) -> AdapterResult<()> {
    let turn_id = Uuid::new_v4().to_string();
    process.bind_turn(&turn_id, event_tx);
    let request_id = process.next_id();
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
    let _ = event_tx.send(RuntimeStreamEvent::StateChanged {
        status: "running".to_string(),
    });
    let mut pending_permissions: HashMap<String, PendingPermission> = HashMap::new();

    loop {
        tokio::select! {
            maybe_command = command_rx.recv() => {
                match maybe_command {
                    Some(LiveSessionCommand::ResolvePermission { tool_call_id, decision, resp }) => {
                        let result = if let Some(pending) = pending_permissions.remove(&tool_call_id) {
                            send_permission_decision(process, pending.request_id, &pending.options, decision).await
                        } else {
                            Err(AdapterError::Protocol("tool call is not waiting for permission".to_string()))
                        };
                        let _ = resp.send(result);
                    }
                    Some(LiveSessionCommand::Cancel { resp }) => {
                        for (_, pending) in pending_permissions.drain() {
                            let _ = send_cancelled_permission(process, pending.request_id).await;
                        }
                        let result = process.write_message(json!({
                            "jsonrpc": "2.0",
                            "method": "session/cancel",
                            "params": {
                                "sessionId": handle.remote_session_id
                            }
                        })).await;
                        let _ = resp.send(result);
                    }
                    Some(LiveSessionCommand::SetConfig { config_id, value, resp }) => {
                        let result = process
                            .request(
                                "session/set_config_option",
                                json!({
                                    "sessionId": handle.remote_session_id,
                                    "configId": config_id,
                                    "value": value
                                }),
                            )
                            .await
                            .map(|response| parse_config_options(response.get("result")));
                        let _ = resp.send(result);
                    }
                    Some(LiveSessionCommand::SetModel { model_id, resp }) => {
                        let result = process
                            .request(
                                "session/set_model",
                                json!({
                                    "sessionId": handle.remote_session_id,
                                    "modelId": model_id
                                }),
                            )
                            .await
                            .map(|response| {
                                let models_from_response = parse_models(response.get("result"));
                                models_from_response.unwrap_or_else(|| AcpSessionModels {
                                    current_model_id: Some(model_id.clone()),
                                    available_models: handle.models.clone().and_then(|m| m.available_models),
                                })
                            });
                        let _ = resp.send(result);
                    }
                    Some(LiveSessionCommand::SetMode { mode_id, resp }) => {
                        let result = process
                            .request(
                                "session/set_mode",
                                json!({
                                    "sessionId": handle.remote_session_id,
                                    "modeId": mode_id
                                }),
                            )
                            .await
                            .map(|response| {
                                let modes_from_response = parse_modes(response.get("result"));
                                modes_from_response.unwrap_or_else(|| AcpSessionModeState {
                                    current_mode_id: mode_id.clone(),
                                    available_modes: handle.modes.clone().map(|m| m.available_modes).unwrap_or_default(),
                                })
                            });
                        let _ = resp.send(result);
                    }
                    Some(LiveSessionCommand::RunTurn { completion_tx, .. }) => {
                        let _ = completion_tx.send(Err(AdapterError::Protocol("a prompt turn is already running".to_string())));
                    }
                    Some(LiveSessionCommand::Close) => {
                        let _ = process.close().await;
                        return Ok(());
                    }
                    None => return Ok(()),
                }
            }
            message = process.read_message() => {
                let message = message?;
                if let Some(method) = message.get("method").and_then(Value::as_str) {
                    match method {
                        "session/update" => {
                            for event in parse_session_update(&message, &turn_id) {
                                let _ = event_tx.send(event);
                            }
                        }
                        "session/request_permission" => {
                            if let Some((event, permission_id, options)) = parse_permission_request(&message, &turn_id) {
                                if let RuntimeStreamEvent::PermissionRequest { tool_call_id, .. } = &event {
                                    pending_permissions.insert(
                                        tool_call_id.clone(),
                                        PendingPermission {
                                            request_id: permission_id,
                                            options,
                                        },
                                    );
                                }
                                let _ = event_tx.send(event);
                            }
                        }
                        _ => {
                            process.handle_client_request(&message).await?;
                        }
                    }
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
                        let _ = event_tx.send(RuntimeStreamEvent::StateChanged {
                            status: stop_reason.to_string(),
                        });
                    }
                    let _ = event_tx.send(RuntimeStreamEvent::TurnFinished { turn_id });
                    process.clear_turn();
                    return Ok(());
                }
            }
        }
    }
}
