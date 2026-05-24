pub mod plugin;
pub mod sidecar;
pub mod session;
pub mod auth;
pub mod crypto;
pub mod throttle;
pub mod weixin_native;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use chrono::Utc;
use parking_lot::RwLock;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn, error, debug};

use crate::gateway::Gateway;
use crate::runtime::event_bus::EventSink;
use crate::channel_api::AppState;
use plugin::{ImPlugin, OutgoingMessage, MessageContent};
use sidecar::SidecarBridge;
use session::ImSessionManager;
use auth::ImAuthService;
use throttle::StreamThrottle;

pub struct ImChannelManager {
    gateway: Arc<Gateway>,
    pub plugins: Arc<RwLock<HashMap<String, Arc<dyn ImPlugin>>>>,
    session_manager: ImSessionManager,
    active_throttles: Arc<Mutex<HashMap<String, StreamThrottle>>>,
    pub active_login_bridge: Arc<Mutex<Option<Arc<weixin_native::WeChatNativePlugin>>>>,
}

impl ImChannelManager {
    pub fn new(gateway: Arc<Gateway>) -> Self {
        let session_manager = ImSessionManager::new(gateway.clone());
        Self {
            gateway,
            plugins: Arc::new(RwLock::new(HashMap::new())),
            session_manager,
            active_throttles: Arc::new(Mutex::new(HashMap::new())),
            active_login_bridge: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn initialize_plugins(&self) -> Result<(), String> {
        let plugins_to_start = {
            let conn = self.gateway.db.conn.lock();
            
            // Ensure table exists (though migrations should have run)
            let mut table_check = conn
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='im_plugins'")
                .map_err(|e| e.to_string())?;
            if !table_check.exists([]).unwrap_or(false) {
                warn!("im_plugins table does not exist. Skipping initialization.");
                None
            } else {
                let mut stmt = conn
                    .prepare("SELECT plugin_type, credentials_json, config_json FROM im_plugins WHERE enabled = 1")
                    .map_err(|e| e.to_string())?;

                let rows = stmt
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    })
                    .map_err(|e| e.to_string())?;

                let mut list = Vec::new();
                for row in rows {
                    if let Ok((plugin_type, creds_encrypted, config_opt)) = row {
                        list.push((plugin_type, creds_encrypted, config_opt));
                    }
                }
                Some(list)
            }
        };

        let plugins_to_start = match plugins_to_start {
            Some(p) => p,
            None => return Ok(()),
        };

        for (plugin_type, creds_encrypted, config_opt) in plugins_to_start {
            // Decrypt credentials
            let creds_str = match crypto::decrypt(&creds_encrypted) {
                Ok(s) => s,
                Err(e) => {
                    error!("Failed to decrypt credentials for plugin {}: {}", plugin_type, e);
                    continue;
                }
            };

            let creds_json: Value = match serde_json::from_str(&creds_str) {
                Ok(v) => v,
                Err(_) => {
                    error!("Failed to parse credentials JSON for plugin {}", plugin_type);
                    continue;
                }
            };

            // Parse config to get sidecar_path
            let sidecar_path = if let Some(config_str) = config_opt {
                if let Ok(config_json) = serde_json::from_str::<Value>(&config_str) {
                    config_json
                        .get("sidecar_path")
                        .and_then(|v| v.as_str())
                        .unwrap_or("../im-sidecar/dist/index.js")
                        .to_string()
                } else {
                    "../im-sidecar/dist/index.js".to_string()
                }
            } else {
                "../im-sidecar/dist/index.js".to_string()
            };

            info!("Auto-starting IM plugin {} with sidecar {}", plugin_type, sidecar_path);
            if let Err(e) = self.start_plugin(&plugin_type, &sidecar_path, creds_json).await {
                error!("Failed to auto-start plugin {}: {}", plugin_type, e);
            }
        }

        Ok(())
    }

    pub async fn start_plugin(&self, platform: &str, sidecar_path: &str, credentials: Value) -> Result<(), String> {
        // Stop first if already running
        let _ = self.stop_plugin(platform).await;

        let (tx, mut rx) = mpsc::unbounded_channel();
        
        let plugin_arc: Arc<dyn ImPlugin> = if platform == "weixin" {
            let plugin = weixin_native::WeChatNativePlugin::new(tx);
            plugin.start(credentials).await?;
            Arc::new(plugin) as Arc<dyn ImPlugin>
        } else {
            let plugin = SidecarBridge::new(platform.to_string(), sidecar_path.to_string(), tx);
            plugin.start(credentials).await?;
            Arc::new(plugin) as Arc<dyn ImPlugin>
        };
        self.plugins.write().insert(platform.to_string(), plugin_arc.clone());
        
        // Spawn task to handle incoming events from this sidecar
        let self_mgr = self.gateway.clone();
        let session_mgr = self.session_manager.clone();
        let platform_str = platform.to_string();
        let plugins_ref = self.plugins.clone();

        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    plugin::SidecarEvent::IncomingMessage(msg) => {
                        // Determine authorization and process
                        let is_auth = ImAuthService::is_authorized(&msg.user_id, &msg.platform, &self_mgr.db)
                            .unwrap_or(false);

                        if !is_auth {
                            // Generate pairing code
                            if let Ok(code) = ImAuthService::generate_pairing_code(&msg.user_id, &msg.platform, Some(&msg.user_name), &self_mgr.db) {
                                self_mgr.runtime.event_bus.broadcast(
                                    "im:pairing_requested",
                                    &json!({
                                        "code": code,
                                        "platform_user_id": msg.user_id,
                                        "platform_type": msg.platform,
                                        "display_name": msg.user_name,
                                    }),
                                );

                                // Send welcome & pairing prompt back
                                let p_opt = {
                                    let plugins = plugins_ref.read();
                                    plugins.get(&msg.platform).cloned()
                                };
                                if let Some(p) = p_opt {
                                    let out_msg = OutgoingMessage {
                                        text: format!(
                                            "Welcome! To pair your account with OneAgent, please enter this code in your settings UI:\n\n{}",
                                            code
                                        ),
                                        buttons: None,
                                        is_streaming_update: false,
                                    };
                                    let _res: Result<String, String> = p.send_message(&msg.chat_id, out_msg).await;
                                }
                            }
                        } else {
                            // Authorized — extract text and check for commands
                            let text = match &msg.content {
                                MessageContent::Text(t) => t.clone(),
                                MessageContent::Command(c) => format!("/{}", c),
                                MessageContent::Action(a) => a.clone(),
                            };

                            let trimmed = text.trim();

                            // Check for system commands (starting with /)
                            if trimmed.starts_with('/') {
                                let (cmd, args) = match trimmed[1..].split_once(char::is_whitespace) {
                                    Some((c, a)) => (c.to_lowercase(), a.trim().to_string()),
                                    None => (trimmed[1..].to_lowercase(), String::new()),
                                };

                                let reply = match cmd.as_str() {
                                    "new" => {
                                        match session_mgr.archive_and_create_new(&msg.platform, &msg.chat_id, None).await {
                                            Ok(_) => "✅ 已创建新对话。\n\nNew conversation created.".to_string(),
                                            Err(e) => format!("❌ 创建新对话失败: {}\n\nFailed to create new conversation: {}", e, e),
                                        }
                                    }
                                    "help" => {
                                        "📋 可用命令 / Available Commands:\n\n\
                                         /new — 创建新对话 / Start a new conversation\n\
                                         /status — 查看当前状态 / View current status\n\
                                         /switch — 列出可用工作区 / List workspaces\n\
                                         /switch <name> — 切换工作区 / Switch workspace\n\
                                         /help — 显示此帮助 / Show this help".to_string()
                                    }
                                    "status" => {
                                        match session_mgr.get_channel_status(&msg.platform, &msg.chat_id) {
                                            Ok((conv_id, ws_name, agent_name)) => {
                                                format!(
                                                    "📊 当前状态 / Current Status\n\n\
                                                     平台 / Platform: {}\n\
                                                     工作区 / Workspace: {}\n\
                                                     Agent: {}\n\
                                                     会话 / Conversation: {}",
                                                    msg.platform, ws_name, agent_name, &conv_id[..8.min(conv_id.len())]
                                                )
                                            }
                                            Err(_) => "⚠️ 当前没有活跃的对话。\n\nNo active conversation. Send any message to start one.".to_string(),
                                        }
                                    }
                                    "switch" => {
                                        if args.is_empty() {
                                            // List available workspaces
                                            match session_mgr.list_available_workspaces() {
                                                Ok(workspaces) if workspaces.is_empty() => {
                                                    "⚠️ 没有可用的工作区。\n\nNo workspaces available.".to_string()
                                                }
                                                Ok(workspaces) => {
                                                    let mut reply = "📂 可用工作区 / Available Workspaces:\n\n".to_string();
                                                    for (_, name) in &workspaces {
                                                        reply.push_str(&format!("• {}\n", name));
                                                    }
                                                    reply.push_str("\n使用 /switch <名称> 切换\nUse /switch <name> to switch");
                                                    reply
                                                }
                                                Err(e) => format!("❌ 获取工作区列表失败: {}\n\nFailed to list workspaces: {}", e, e),
                                            }
                                        } else {
                                            // Switch to specified workspace by display_name
                                            match session_mgr.list_available_workspaces() {
                                                Ok(workspaces) => {
                                                    let target = args.to_lowercase();
                                                    let found = workspaces.iter().find(|(_, name)| name.to_lowercase() == target);
                                                    match found {
                                                        Some((ws_id, ws_name)) => {
                                                            match session_mgr.switch_workspace(&msg.platform, &msg.chat_id, ws_id).await {
                                                                Ok(_) => format!("✅ 已切换到工作区: {}\n\nSwitched to workspace: {}", ws_name, ws_name),
                                                                Err(e) => format!("❌ 切换工作区失败: {}\n\nFailed to switch workspace: {}", e, e),
                                                            }
                                                        }
                                                        None => {
                                                            // Try partial match
                                                            let partial: Vec<_> = workspaces.iter()
                                                                .filter(|(_, name)| name.to_lowercase().contains(&target))
                                                                .collect();
                                                            if partial.len() == 1 {
                                                                let (ws_id, ws_name) = partial[0];
                                                                match session_mgr.switch_workspace(&msg.platform, &msg.chat_id, ws_id).await {
                                                                    Ok(_) => format!("✅ 已切换到工作区: {}\n\nSwitched to workspace: {}", ws_name, ws_name),
                                                                    Err(e) => format!("❌ 切换工作区失败: {}\n\nFailed to switch workspace: {}", e, e),
                                                                }
                                                            } else if partial.is_empty() {
                                                                format!("⚠️ 找不到工作区 \"{}\"\n\nWorkspace \"{}\" not found. Use /switch to list all.", args, args)
                                                            } else {
                                                                let mut reply = format!("⚠️ 找到多个匹配的工作区 / Multiple matches for \"{}\":\n\n", args);
                                                                for (_, name) in &partial {
                                                                    reply.push_str(&format!("• {}\n", name));
                                                                }
                                                                reply.push_str("\n请使用精确名称。\nPlease use an exact name.");
                                                                reply
                                                            }
                                                        }
                                                    }
                                                }
                                                Err(e) => format!("❌ 获取工作区列表失败: {}\n\nFailed to list workspaces: {}", e, e),
                                            }
                                        }
                                    }
                                    _ => {
                                        // Not a system command — forward to agent as normal message
                                        if let Ok(conversation_id) = session_mgr.get_or_create_conversation(&msg.platform, &msg.chat_id, Some(&text)).await {
                                            let _ = self_mgr.send_user_message(&conversation_id, &text, vec![]).await;
                                        }
                                        String::new() // No reply needed, agent will respond
                                    }
                                };

                                // Send command response back to user (if non-empty)
                                if !reply.is_empty() {
                                    let p_opt = {
                                        let plugins = plugins_ref.read();
                                        plugins.get(&msg.platform).cloned()
                                    };
                                    if let Some(p) = p_opt {
                                        let out_msg = OutgoingMessage {
                                            text: reply,
                                            buttons: None,
                                            is_streaming_update: false,
                                        };
                                        let _ = p.send_message(&msg.chat_id, out_msg).await;
                                    }
                                }
                            } else {
                                // Regular message — forward to agent
                                if let Ok(conversation_id) = session_mgr.get_or_create_conversation(&msg.platform, &msg.chat_id, Some(&text)).await {
                                    let _ = self_mgr.send_user_message(&conversation_id, &text, vec![]).await;
                                }
                            }
                        }
                    }
                    plugin::SidecarEvent::WeixinLoginQr(qr_url) => {
                        self_mgr.runtime.event_bus.broadcast("im:weixin_login_qr", &json!({ "qr_url": qr_url }));
                    }
                    plugin::SidecarEvent::WeixinLoginScanned => {
                        self_mgr.runtime.event_bus.broadcast("im:weixin_login_scanned", &json!({}));
                    }
                    plugin::SidecarEvent::WeixinLoginDone { account_id, bot_token } => {
                        self_mgr.runtime.event_bus.broadcast("im:weixin_login_done", &json!({
                            "account_id": account_id,
                            "bot_token": bot_token,
                        }));
                    }
                }
            }
            info!("Incoming event stream closed for platform {}", platform_str);
        });
        
        Ok(())
    }

    pub async fn stop_plugin(&self, platform: &str) -> Result<(), String> {
        let plugin = {
            let mut plugins = self.plugins.write();
            plugins.remove(platform)
        };
        if let Some(plugin) = plugin {
            plugin.stop().await?;
        }
        Ok(())
    }

    pub async fn handle_runtime_event(&self, event: &str, payload: &Value) -> Result<(), String> {
        if event == "conversation:message_appended" || event == "conversation:message_updated" {
            let conv_id = payload.get("conversation_id").and_then(|v| v.as_str())
                .ok_or_else(|| "Missing conversation_id".to_string())?;

            let message = payload.get("message")
                .ok_or_else(|| "Missing message in payload".to_string())?;

            let role = message.get("role").and_then(|v| v.as_str()).unwrap_or("");
            if role != "agent" {
                return Ok(());
            }

            let kind = message.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            if kind != "text" {
                return Ok(());
            }

            let content_json = message.get("content_json")
                .ok_or_else(|| "Missing content_json".to_string())?;
            let text = content_json.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let is_stream = content_json.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);

            // Check if this conversation belongs to an IM platform
            let db_result = {
                let db = &self.gateway.db;
                let conn = db.conn.lock();
                let mut stmt = conn.prepare("SELECT source, channel_chat_id FROM conversations WHERE id = ?1")
                    .map_err(|e| e.to_string())?;
                
                stmt.query_row([conv_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                }).ok()
            };

            if let Some((source, channel_chat_id)) = db_result {
                if source == "oneagent" {
                    return Ok(());
                }

                // Find plugin
                let plugin = {
                    let plugins = self.plugins.read();
                    plugins.get(&source).cloned()
                };

                let plugin = match plugin {
                    Some(p) => p,
                    None => return Err(format!("Plugin not found for platform {}", source)),
                };

                let mut throttles = self.active_throttles.lock().await;
                if !throttles.contains_key(conv_id) {
                    let out_msg = OutgoingMessage {
                        text: text.to_string(),
                        buttons: None,
                        is_streaming_update: is_stream,
                    };
                    let msg_id = plugin.send_message(&channel_chat_id, out_msg).await
                        .map_err(|e| format!("Failed to send initial IM message: {}", e))?;

                    if is_stream {
                        let throttle = StreamThrottle::new(
                            channel_chat_id,
                            msg_id,
                            plugin,
                            Duration::from_millis(500),
                        );
                        throttles.insert(conv_id.to_string(), throttle);
                    }
                } else {
                    let throttle = throttles.get(conv_id).unwrap();
                    if is_stream {
                        throttle.feed(text.to_string()).await;
                    } else {
                        throttle.finish(None).await;
                        throttles.remove(conv_id);
                    }
                }
            }
        } else if event == "conversation:turn_finished" {
            let conv_id = payload.get("conversation_id").and_then(|v| v.as_str())
                .ok_or_else(|| "Missing conversation_id".to_string())?;

            let mut throttles = self.active_throttles.lock().await;
            if let Some(throttle) = throttles.remove(conv_id) {
                throttle.finish(None).await;
            }
        }
        Ok(())
    }
}

pub struct ImChannelEventSink {
    manager: Arc<ImChannelManager>,
}

impl ImChannelEventSink {
    pub fn new(manager: Arc<ImChannelManager>) -> Self {
        Self { manager }
    }
}

impl EventSink for ImChannelEventSink {
    fn emit(&self, event: &str, payload: &Value) {
        let manager = self.manager.clone();
        let event = event.to_string();
        let payload = payload.clone();
        
        tokio::spawn(async move {
            if let Err(e) = manager.handle_runtime_event(&event, &payload).await {
                debug!("IM Channel event handler failed: {}", e);
            }
        });
    }
}

#[derive(serde::Serialize)]
pub struct ImPluginInfo {
    pub platform: String,
    pub enabled: bool,
    pub status: String,
    pub workspace_id: Option<String>,
    pub agent_profile_id: Option<String>,
    pub model_id: Option<String>,
}

// Tauri commands implementation helper functions
pub async fn list_im_plugins_impl(
    gateway: &Gateway,
    im_manager: &ImChannelManager,
) -> Result<Vec<ImPluginInfo>, crate::domain::BackendError> {
    let db = &gateway.db;
    let conn = db.conn.lock();
    
    // Ensure table exists
    let mut table_check = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='im_plugins'")
        .map_err(|e| crate::domain::BackendError::new(crate::domain::ErrorCode::StorageError, e.to_string()))?;
    if !table_check.exists([]).unwrap_or(false) {
        return Ok(vec![
            ImPluginInfo { platform: "weixin".to_string(), enabled: false, status: "disconnected".to_string(), workspace_id: None, agent_profile_id: None, model_id: None },
            ImPluginInfo { platform: "lark".to_string(), enabled: false, status: "disconnected".to_string(), workspace_id: None, agent_profile_id: None, model_id: None },
            ImPluginInfo { platform: "dingtalk".to_string(), enabled: false, status: "disconnected".to_string(), workspace_id: None, agent_profile_id: None, model_id: None },
            ImPluginInfo { platform: "telegram".to_string(), enabled: false, status: "disconnected".to_string(), workspace_id: None, agent_profile_id: None, model_id: None },
        ]);
    }

    let mut stmt = conn
        .prepare("SELECT plugin_type, enabled, config_json FROM im_plugins")
        .map_err(|e| crate::domain::BackendError::new(crate::domain::ErrorCode::StorageError, e.to_string()))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i32>(1)? != 0,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| crate::domain::BackendError::new(crate::domain::ErrorCode::StorageError, e.to_string()))?;

    let mut list = Vec::new();
    let plugins = im_manager.plugins.read();
    
    for row in rows {
        if let Ok((platform, enabled, config_opt)) = row {
            let status = if let Some(p) = plugins.get(&platform) {
                match p.status() {
                    plugin::PluginStatus::Disconnected => "disconnected",
                    plugin::PluginStatus::Connecting => "connecting",
                    plugin::PluginStatus::Connected => "connected",
                    plugin::PluginStatus::Error => "error",
                }.to_string()
            } else {
                "disconnected".to_string()
            };
            
            let mut workspace_id = None;
            let mut agent_profile_id = None;
            let mut model_id = None;
            if let Some(config_str) = config_opt {
                if let Ok(config_json) = serde_json::from_str::<Value>(&config_str) {
                    workspace_id = config_json.get("workspace_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                    agent_profile_id = config_json.get("agent_profile_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                    model_id = config_json.get("model_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                }
            }

            list.push(ImPluginInfo { platform, enabled, status, workspace_id, agent_profile_id, model_id });
        }
    }
    
    // Ensure defaults exist
    let defaults = vec!["weixin", "lark", "dingtalk", "telegram"];
    for default in defaults {
        if !list.iter().any(|p| p.platform == default) {
            list.push(ImPluginInfo {
                platform: default.to_string(),
                enabled: false,
                status: "disconnected".to_string(),
                workspace_id: None,
                agent_profile_id: None,
                model_id: None,
            });
        }
    }

    Ok(list)
}

pub async fn start_im_plugin_impl(
    gateway: &Gateway,
    im_manager: &ImChannelManager,
    platform: String,
    sidecar_path: String,
    credentials_json: String,
    workspace_id: Option<String>,
    agent_profile_id: Option<String>,
    model_id: Option<String>,
) -> Result<(), crate::domain::BackendError> {
    let encrypted_creds = crypto::encrypt(&credentials_json)
        .map_err(|e| crate::domain::BackendError::new(crate::domain::ErrorCode::InvalidInput, e))?;

    // Try to load existing config to preserve other parameters (e.g. workspace_id if not specified)
    let db = &gateway.db;
    let mut existing_config = Value::Null;
    {
        let conn = db.conn.lock();
        let config_str: Option<String> = conn.query_row(
            "SELECT config_json FROM im_plugins WHERE plugin_type = ?1",
            [&platform],
            |row| row.get(0)
        ).ok().flatten();
        if let Some(s) = config_str {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                existing_config = v;
            }
        }
    }

    let final_workspace_id = workspace_id.or_else(|| {
        existing_config.get("workspace_id").and_then(|v| v.as_str()).map(String::from)
    });
    let final_agent_profile_id = agent_profile_id.or_else(|| {
        existing_config.get("agent_profile_id").and_then(|v| v.as_str()).map(String::from)
    });
    let final_model_id = model_id.or_else(|| {
        existing_config.get("model_id").and_then(|v| v.as_str()).map(String::from)
    });

    let config_json = json!({
        "sidecar_path": sidecar_path,
        "workspace_id": final_workspace_id,
        "agent_profile_id": final_agent_profile_id,
        "model_id": final_model_id,
    }).to_string();
    let now = Utc::now().timestamp();

    {
        let conn = db.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO im_plugins (id, plugin_type, name, enabled, credentials_json, config_json, created_at, updated_at)
             VALUES (?1, ?2, ?2, 1, ?3, ?4, ?5, ?5)",
            rusqlite::params![platform, platform, encrypted_creds, config_json, now],
        )
        .map_err(|e| crate::domain::BackendError::new(crate::domain::ErrorCode::StorageError, e.to_string()))?;
    }

    let creds_val: Value = serde_json::from_str(&credentials_json)
        .map_err(|e| crate::domain::BackendError::new(crate::domain::ErrorCode::InvalidInput, e.to_string()))?;

    im_manager
        .start_plugin(&platform, &sidecar_path, creds_val)
        .await
        .map_err(|e| crate::domain::BackendError::new(crate::domain::ErrorCode::AdapterSpawnFailed, e))?;

    Ok(())
}

pub async fn update_im_plugin_config_impl(
    gateway: &Gateway,
    platform: String,
    workspace_id: Option<String>,
    agent_profile_id: Option<String>,
    model_id: Option<String>,
) -> Result<(), crate::domain::BackendError> {
    let db = &gateway.db;
    let conn = db.conn.lock();

    let mut stmt = conn
        .prepare("SELECT credentials_json, config_json FROM im_plugins WHERE plugin_type = ?1")
        .map_err(|e| crate::domain::BackendError::new(crate::domain::ErrorCode::StorageError, e.to_string()))?;

    let existing: Option<(String, Option<String>)> = stmt
        .query_row([&platform], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .ok();

    let now = Utc::now().timestamp();
    if let Some((_, config_opt)) = existing {
        let mut config_val = if let Some(config_str) = config_opt {
            serde_json::from_str::<Value>(&config_str).unwrap_or(json!({}))
        } else {
            json!({})
        };

        config_val["workspace_id"] = workspace_id.clone().map(|id| Value::String(id)).unwrap_or(Value::Null);
        config_val["agent_profile_id"] = agent_profile_id.clone().map(|id| Value::String(id)).unwrap_or(Value::Null);
        config_val["model_id"] = model_id.clone().map(|id| Value::String(id)).unwrap_or(Value::Null);

        let config_str = config_val.to_string();
        conn.execute(
            "UPDATE im_plugins SET config_json = ?1, updated_at = ?2 WHERE plugin_type = ?3",
            rusqlite::params![config_str, now, &platform],
        )
        .map_err(|e| crate::domain::BackendError::new(crate::domain::ErrorCode::StorageError, e.to_string()))?;
    } else {
        // Create new row with empty credentials
        let config_val = json!({
            "workspace_id": workspace_id.clone(),
            "agent_profile_id": agent_profile_id.clone(),
            "model_id": model_id.clone(),
            "sidecar_path": "./im-sidecar/dist/index.js",
        });
        conn.execute(
            "INSERT INTO im_plugins (id, plugin_type, name, enabled, credentials_json, config_json, created_at, updated_at)
             VALUES (?1, ?2, ?2, 0, ?3, ?4, ?5, ?5)",
            rusqlite::params![platform, platform, "", config_val.to_string(), now],
        )
        .map_err(|e| crate::domain::BackendError::new(crate::domain::ErrorCode::StorageError, e.to_string()))?;
    }

    // Broadcast config change so frontend and other parts stay in sync
    gateway.runtime.event_bus.broadcast(
        "im:plugin_config_changed",
        &json!({
            "platform": platform,
            "workspace_id": workspace_id,
            "agent_profile_id": agent_profile_id,
            "model_id": model_id,
        }),
    );

    Ok(())
}

pub async fn stop_im_plugin_impl(
    gateway: &Gateway,
    im_manager: &ImChannelManager,
    platform: String,
) -> Result<(), crate::domain::BackendError> {
    let db = &gateway.db;
    {
        let conn = db.conn.lock();
        conn.execute(
            "UPDATE im_plugins SET enabled = 0 WHERE plugin_type = ?1",
            [&platform],
        )
        .map_err(|e| crate::domain::BackendError::new(crate::domain::ErrorCode::StorageError, e.to_string()))?;
    }

    im_manager
        .stop_plugin(&platform)
        .await
        .map_err(|e| crate::domain::BackendError::new(crate::domain::ErrorCode::AdapterError, e))?;

    Ok(())
}

pub async fn approve_im_pairing_impl(
    gateway: &Gateway,
    code: String,
) -> Result<String, crate::domain::BackendError> {
    let (platform_user_id, platform_type) = ImAuthService::approve_pairing(&code, &gateway.db)
        .map_err(|e| crate::domain::BackendError::new(crate::domain::ErrorCode::InvalidInput, e))?;

    gateway.runtime.event_bus.broadcast(
        "im:user_authorized",
        &json!({
            "platform_user_id": platform_user_id,
            "platform_type": platform_type,
        }),
    );

    Ok(format!("Authorized user {} on platform {}", platform_user_id, platform_type))
}

pub async fn start_weixin_login_impl(
    gateway: &Arc<Gateway>,
    im_manager: &ImChannelManager,
    _sidecar_path: String,
) -> Result<(), crate::domain::BackendError> {
    // 1. Stop active WeChat plugin if running
    let _ = im_manager.stop_plugin("weixin").await;

    // 2. Stop any active login bridge
    {
        let mut active_opt = im_manager.active_login_bridge.lock().await;
        if let Some(bridge) = active_opt.take() {
            let _ = bridge.stop_login().await;
        }
    }

    // 3. Create a temporary WeChatNativePlugin
    let (tx, mut rx) = mpsc::unbounded_channel();
    let bridge = Arc::new(weixin_native::WeChatNativePlugin::new(tx));

    // 4. Store in active_login_bridge
    {
        let mut active_opt = im_manager.active_login_bridge.lock().await;
        *active_opt = Some(bridge.clone());
    }

    // 5. Spawn event handling task
    let self_mgr = gateway.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                plugin::SidecarEvent::WeixinLoginQr(qr_url) => {
                    self_mgr.runtime.event_bus.broadcast("im:weixin_login_qr", &json!({ "qr_url": qr_url }));
                }
                plugin::SidecarEvent::WeixinLoginScanned => {
                    self_mgr.runtime.event_bus.broadcast("im:weixin_login_scanned", &json!({}));
                }
                plugin::SidecarEvent::WeixinLoginDone { account_id, bot_token } => {
                    self_mgr.runtime.event_bus.broadcast("im:weixin_login_done", &json!({
                        "account_id": account_id,
                        "bot_token": bot_token,
                    }));
                }
                plugin::SidecarEvent::IncomingMessage(_) => {}
            }
        }
    });

    // 6. Start the native login process
    bridge.start_login().await
        .map_err(|e| crate::domain::BackendError::new(crate::domain::ErrorCode::AdapterSpawnFailed, e))?;

    Ok(())
}

pub async fn stop_weixin_login_impl(
    im_manager: &ImChannelManager,
) -> Result<(), crate::domain::BackendError> {
    let mut active_opt = im_manager.active_login_bridge.lock().await;
    if let Some(bridge) = active_opt.take() {
        let _ = bridge.stop_login().await;
    }
    Ok(())
}

// Tauri commands
#[tauri::command]
pub async fn list_im_plugins(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ImPluginInfo>, crate::domain::BackendError> {
    list_im_plugins_impl(&state.gateway, &state.im_manager).await
}

#[tauri::command]
pub async fn start_im_plugin(
    state: tauri::State<'_, AppState>,
    platform: String,
    sidecar_path: String,
    credentials_json: String,
    workspace_id: Option<String>,
    agent_profile_id: Option<String>,
    model_id: Option<String>,
) -> Result<(), crate::domain::BackendError> {
    start_im_plugin_impl(&state.gateway, &state.im_manager, platform, sidecar_path, credentials_json, workspace_id, agent_profile_id, model_id).await
}

#[tauri::command]
pub async fn update_im_plugin_config(
    state: tauri::State<'_, AppState>,
    platform: String,
    workspace_id: Option<String>,
    agent_profile_id: Option<String>,
    model_id: Option<String>,
) -> Result<(), crate::domain::BackendError> {
    update_im_plugin_config_impl(&state.gateway, platform, workspace_id, agent_profile_id, model_id).await
}

#[tauri::command]
pub async fn stop_im_plugin(
    state: tauri::State<'_, AppState>,
    platform: String,
) -> Result<(), crate::domain::BackendError> {
    stop_im_plugin_impl(&state.gateway, &state.im_manager, platform).await
}

#[tauri::command]
pub async fn approve_im_pairing(
    state: tauri::State<'_, AppState>,
    code: String,
) -> Result<String, crate::domain::BackendError> {
    approve_im_pairing_impl(&state.gateway, code).await
}

#[tauri::command]
pub async fn start_weixin_login(
    state: tauri::State<'_, AppState>,
    sidecar_path: String,
) -> Result<(), crate::domain::BackendError> {
    start_weixin_login_impl(&state.gateway, &state.im_manager, sidecar_path).await
}

#[tauri::command]
pub async fn stop_weixin_login(
    state: tauri::State<'_, AppState>,
) -> Result<(), crate::domain::BackendError> {
    stop_weixin_login_impl(&state.im_manager).await
}

