use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, warn};

use crate::channel_api::im::plugin::{ImPlugin, IncomingMessage, OutgoingMessage, PluginStatus, SidecarEvent};

pub struct SidecarBridge {
    platform: String,
    sidecar_path: String,
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<tokio::sync::Mutex<Option<BufWriter<ChildStdin>>>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    next_id: AtomicU64,
    status: Arc<Mutex<PluginStatus>>,
    event_tx: mpsc::UnboundedSender<SidecarEvent>,
}

impl SidecarBridge {
    pub fn new(
        platform: String,
        sidecar_path: String,
        event_tx: mpsc::UnboundedSender<SidecarEvent>,
    ) -> Self {
        Self {
            platform,
            sidecar_path,
            child: Arc::new(Mutex::new(None)),
            stdin: Arc::new(tokio::sync::Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            status: Arc::new(Mutex::new(PluginStatus::Disconnected)),
            event_tx,
        }
    }

    pub(crate) async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let req_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let request = json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
            "params": params
        });

        let req_str = serde_json::to_string(&request).map_err(|e| e.to_string())? + "\n";
        
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(req_id, tx);

        // Write to stdin
        let mut stdin_guard = self.stdin.lock().await;
        if let Some(ref mut stdin) = *stdin_guard {
            stdin.write_all(req_str.as_bytes()).await.map_err(|e| {
                self.pending.lock().remove(&req_id);
                format!("Failed to write to sidecar stdin: {}", e)
            })?;
            stdin.flush().await.map_err(|e| {
                self.pending.lock().remove(&req_id);
                format!("Failed to flush sidecar stdin: {}", e)
            })?;
        } else {
            self.pending.lock().remove(&req_id);
            return Err("Sidecar is not running".to_string());
        }
        drop(stdin_guard);

        // Wait for response
        match tokio::time::timeout(Duration::from_secs(60), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Request cancelled".to_string()),
            Err(_) => {
                self.pending.lock().remove(&req_id);
                Err("Request timed out after 60 seconds".to_string())
            }
        }
    }

    pub fn set_status(&self, new_status: PluginStatus) {
        *self.status.lock() = new_status;
    }
}

#[async_trait]
impl ImPlugin for SidecarBridge {
    fn platform(&self) -> &str {
        &self.platform
    }

    async fn start(&self, config: Value) -> Result<(), String> {
        {
            let mut status_guard = self.status.lock();
            if *status_guard == PluginStatus::Connected || *status_guard == PluginStatus::Connecting {
                return Ok(());
            }
            *status_guard = PluginStatus::Connecting;
        }

        // Spawn node sidecar
        // Resolve relative paths against the project root (parent of src-tauri/)
        let resolved_path = {
            let p = std::path::Path::new(&self.sidecar_path);
            if p.is_absolute() {
                self.sidecar_path.clone()
            } else {
                let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
                if let Some(project_root) = manifest_dir.parent() {
                    let abs_path = project_root.join(&self.sidecar_path);
                    abs_path.to_string_lossy().to_string()
                } else {
                    self.sidecar_path.clone()
                }
            }
        };
        info!("Spawning sidecar: node {}", resolved_path);

        let mut cmd = Command::new("node");
        cmd.arg(&resolved_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            *self.status.lock() = PluginStatus::Error;
            format!("Failed to spawn sidecar process (node {}): {}", resolved_path, e)
        })?;

        let stdin = child.stdin.take().ok_or_else(|| {
            *self.status.lock() = PluginStatus::Error;
            "Failed to open sidecar stdin".to_string()
        })?;
        
        let stdout = child.stdout.take().ok_or_else(|| {
            *self.status.lock() = PluginStatus::Error;
            "Failed to open sidecar stdout".to_string()
        })?;

        let stderr = child.stderr.take().ok_or_else(|| {
            *self.status.lock() = PluginStatus::Error;
            "Failed to open sidecar stderr".to_string()
        })?;

        *self.child.lock() = Some(child);
        *self.stdin.lock().await = Some(BufWriter::new(stdin));

        // Start processing stdout/stderr in background
        let pending = self.pending.clone();
        let event_tx = self.event_tx.clone();
        let status = self.status.clone();
        
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                debug!("Sidecar stdout line: {}", line);
                if let Ok(val) = serde_json::from_str::<Value>(&line) {
                    if val.get("jsonrpc").and_then(|v| v.as_str()) == Some("2.0") {
                        if let Some(id_val) = val.get("id") {
                            // Response
                            if let Some(id) = id_val.as_u64() {
                                let mut pending_lock = pending.lock();
                                if let Some(tx) = pending_lock.remove(&id) {
                                    if let Some(err) = val.get("error") {
                                        let err_msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("Unknown sidecar error").to_string();
                                        let _ = tx.send(Err(err_msg));
                                    } else {
                                        let result = val.get("result").cloned().unwrap_or(Value::Null);
                                        let _ = tx.send(Ok(result));
                                    }
                                }
                            }
                        } else if let Some(method_val) = val.get("method").and_then(|m| m.as_str()) {
                            // Notification
                            if method_val == "incoming_message" {
                                if let Some(params) = val.get("params") {
                                    if let Ok(msg) = serde_json::from_value::<IncomingMessage>(params.clone()) {
                                        let _ = event_tx.send(SidecarEvent::IncomingMessage(msg));
                                    } else {
                                        warn!("Failed to parse incoming_message params: {:?}", params);
                                    }
                                }
                            } else if method_val == "weixin_login_qr" {
                                if let Some(params) = val.get("params") {
                                    if let Some(qr_url) = params.get("qr_url").and_then(|q| q.as_str()) {
                                        let _ = event_tx.send(SidecarEvent::WeixinLoginQr(qr_url.to_string()));
                                    }
                                }
                            } else if method_val == "weixin_login_scanned" {
                                let _ = event_tx.send(SidecarEvent::WeixinLoginScanned);
                            } else if method_val == "weixin_login_done" {
                                if let Some(params) = val.get("params") {
                                    let account_id = params.get("account_id").and_then(|a| a.as_str()).unwrap_or("").to_string();
                                    let bot_token = params.get("bot_token").and_then(|t| t.as_str()).unwrap_or("").to_string();
                                    let _ = event_tx.send(SidecarEvent::WeixinLoginDone { account_id, bot_token });
                                }
                            } else if method_val == "plugin_status_changed" {
                                if let Some(params) = val.get("params") {
                                    if let Some(new_status_str) = params.get("status").and_then(|s| s.as_str()) {
                                        let new_status = match new_status_str {
                                            "disconnected" => PluginStatus::Disconnected,
                                            "connecting" => PluginStatus::Connecting,
                                            "connected" => PluginStatus::Connected,
                                            "error" => PluginStatus::Error,
                                            _ => PluginStatus::Disconnected,
                                        };
                                        *status.lock() = new_status;
                                        info!("Sidecar status updated to: {:?}", new_status);
                                    }
                                }
                            } else if method_val == "plugin_error" {
                                if let Some(params) = val.get("params") {
                                    let error_msg = params.get("error").and_then(|e| e.as_str()).unwrap_or("Unknown error");
                                    error!("Sidecar plugin error: {}", error_msg);
                                }
                            }
                        }
                    }
                }
            }
            // Stream ended, process died
            *status.lock() = PluginStatus::Disconnected;
            info!("Sidecar stdout stream ended");
        });

        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                warn!("Sidecar stderr: {}", line);
            }
        });

        // Send start command to plugin
        self.call("plugin.start", json!({
            "plugin_type": self.platform,
            "config": config
        })).await?;

        *self.status.lock() = PluginStatus::Connected;
        Ok(())
    }

    async fn stop(&self) -> Result<(), String> {
        let _ = self.call("plugin.stop", json!({
            "plugin_type": self.platform
        })).await;

        *self.status.lock() = PluginStatus::Disconnected;
        
        let mut stdin_guard = self.stdin.lock().await;
        *stdin_guard = None;

        let child = {
            let mut child_guard = self.child.lock();
            child_guard.take()
        };
        if let Some(mut c) = child {
            let _ = c.kill().await;
        }

        Ok(())
    }

    async fn send_message(&self, chat_id: &str, msg: OutgoingMessage) -> Result<String, String> {
        let res = self.call("plugin.send_message", json!({
            "plugin_type": self.platform,
            "chat_id": chat_id,
            "message": msg
        })).await?;

        res.as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "Expected string message ID response".to_string())
    }

    async fn edit_message(&self, chat_id: &str, msg_id: &str, msg: OutgoingMessage) -> Result<(), String> {
        self.call("plugin.edit_message", json!({
            "plugin_type": self.platform,
            "chat_id": chat_id,
            "msg_id": msg_id,
            "message": msg
        })).await?;
        Ok(())
    }

    fn status(&self) -> PluginStatus {
        *self.status.lock()
    }
}
