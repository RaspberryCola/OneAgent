use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::RwLock;
use tokio::sync::{mpsc, Mutex as TokioMutex};
use tracing::{info, error};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};

use crate::channel_api::im::plugin::{ImPlugin, IncomingMessage, OutgoingMessage, PluginStatus, SidecarEvent, MessageContent};
use wechatbot::bot::{WeChatBot, BotOptions};

pub struct WeChatNativePlugin {
    status: Arc<RwLock<PluginStatus>>,
    bot: Arc<tokio::sync::RwLock<Option<Arc<WeChatBot>>>>,
    event_tx: mpsc::UnboundedSender<SidecarEvent>,
    poll_task: Arc<TokioMutex<Option<tokio::task::JoinHandle<()>>>>,
    drafts: Arc<RwLock<HashMap<String, String>>>,
}

fn strip_html(input: &str) -> String {
    let mut output = String::new();
    let mut in_tag = false;
    for c in input.chars() {
        if c == '<' {
            in_tag = true;
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag {
            output.push(c);
        }
    }
    output
}

fn generate_qr_svg_base64(url: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(url.as_bytes())
        .map_err(|e| format!("Failed to create QR code: {}", e))?;
    let svg_xml = code.render::<qrcode::render::svg::Color>().build();
    let base64_svg = BASE64_STANDARD.encode(svg_xml.as_bytes());
    Ok(format!("data:image/svg+xml;base64,{}", base64_svg))
}

impl WeChatNativePlugin {
    pub fn new(event_tx: mpsc::UnboundedSender<SidecarEvent>) -> Self {
        Self {
            status: Arc::new(RwLock::new(PluginStatus::Disconnected)),
            bot: Arc::new(tokio::sync::RwLock::new(None)),
            event_tx,
            poll_task: Arc::new(TokioMutex::new(None)),
            drafts: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn start_login(&self) -> Result<(), String> {
        info!("Starting WeChat scan login flow natively...");
        
        // 1. Stop any active poll task and bot
        self.stop_internal().await;
        
        *self.status.write() = PluginStatus::Connecting;
        
        // 2. Resolve credentials path
        let db_dir = dirs::data_local_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("oneagent");
        std::fs::create_dir_all(&db_dir)
            .map_err(|e| format!("Failed to create database directory: {}", e))?;
        let wechat_creds_path = db_dir.join("wechatbot_creds.json").to_string_lossy().to_string();
        
        // Remove old credentials file to ensure we don't auto-login during a fresh login request
        let _ = std::fs::remove_file(&wechat_creds_path);
        
        // 3. Prepare QR callbacks
        let event_tx_clone = self.event_tx.clone();
        let on_qr_url = Box::new(move |qr_url: &str| {
            let formatted_qr = if qr_url.starts_with("data:") {
                qr_url.to_string()
            } else {
                match generate_qr_svg_base64(qr_url) {
                    Ok(svg_base64) => svg_base64,
                    Err(e) => {
                        error!("Failed to generate QR code SVG base64: {}", e);
                        qr_url.to_string()
                    }
                }
            };
            let _ = event_tx_clone.send(SidecarEvent::WeixinLoginQr(formatted_qr));
        });
        
        let on_error = Box::new(move |err: &wechatbot::error::WeChatBotError| {
            error!("WeChat login bot error: {}", err);
        });
        
        let opts = BotOptions {
            base_url: None,
            cred_path: Some(wechat_creds_path),
            on_qr_url: Some(on_qr_url),
            on_error: Some(on_error),
        };
        
        let bot = Arc::new(WeChatBot::new(opts));
        
        // Register message handler
        let event_tx_msg = self.event_tx.clone();
        bot.on_message(Box::new(move |msg| {
            info!("Received WeChat message during login/polling: {:?}", msg);
            let incoming = IncomingMessage {
                id: msg.raw.client_id.clone(),
                platform: "weixin".to_string(),
                chat_id: msg.user_id.clone(),
                user_id: msg.user_id.clone(),
                user_name: "WeChat User".to_string(),
                content: MessageContent::Text(msg.text.clone()),
                timestamp: msg.timestamp.duration_since(std::time::SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64,
            };
            let _ = event_tx_msg.send(SidecarEvent::IncomingMessage(incoming));
        })).await;
        
        {
            let mut bot_guard = self.bot.write().await;
            *bot_guard = Some(bot.clone());
        }
        
        // 4. Spawn login task
        let bot_clone = bot.clone();
        let event_tx_done = self.event_tx.clone();
        let status_clone = self.status.clone();
        
        let login_handle = tokio::spawn(async move {
            match bot_clone.login(true).await {
                Ok(creds) => {
                    info!("WeChat login confirmed natively: account_id={}", creds.account_id);
                    *status_clone.write() = PluginStatus::Connected;
                    
                    // Emit done event to trigger frontend start_im_plugin
                    let _ = event_tx_done.send(SidecarEvent::WeixinLoginDone {
                        account_id: creds.account_id.clone(),
                        bot_token: creds.token.clone(),
                    });
                    
                    // Proceed to run bot updates loop
                    if let Err(e) = bot_clone.run().await {
                        error!("WeChat bot run loop error after login: {}", e);
                        *status_clone.write() = PluginStatus::Error;
                    }
                }
                Err(e) => {
                    error!("WeChat bot login error: {}", e);
                    *status_clone.write() = PluginStatus::Error;
                }
            }
        });
        
        {
            let mut task_guard = self.poll_task.lock().await;
            *task_guard = Some(login_handle);
        }
        
        Ok(())
    }

    pub async fn stop_login(&self) -> Result<(), String> {
        info!("Stopping WeChat scan login flow...");
        self.stop_internal().await;
        Ok(())
    }

    async fn stop_internal(&self) {
        let mut task_guard = self.poll_task.lock().await;
        if let Some(handle) = task_guard.take() {
            handle.abort();
        }
        
        let bot_guard = self.bot.write().await;
        if let Some(ref bot) = *bot_guard {
            bot.stop().await;
        }
        
        *self.status.write() = PluginStatus::Disconnected;
    }
}

#[async_trait]
impl ImPlugin for WeChatNativePlugin {
    fn platform(&self) -> &str {
        "weixin"
    }

    async fn start(&self, config: Value) -> Result<(), String> {
        info!("Starting WeChatNativePlugin normally with config: {:?}", config);
        
        let account_id = config.get("accountId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing accountId".to_string())?
            .to_string();
            
        let bot_token = config.get("botToken")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing botToken".to_string())?
            .to_string();
            
        let base_url = config.get("baseUrl")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
            
        // 1. Stop any active poll task and bot
        self.stop_internal().await;
        
        *self.status.write() = PluginStatus::Connecting;
        
        // 2. Resolve credentials path
        let db_dir = dirs::data_local_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("oneagent");
        std::fs::create_dir_all(&db_dir)
            .map_err(|e| format!("Failed to create database directory: {}", e))?;
        let wechat_creds_path = db_dir.join("wechatbot_creds.json");
        
        // 3. Prepare credentials struct
        let creds = wechatbot::types::Credentials {
            token: bot_token.clone(),
            base_url: base_url.clone().unwrap_or_else(|| "https://ilinkai.weixin.qq.com".to_string()),
            account_id: account_id.clone(),
            user_id: account_id.clone(), // use account_id as fallback
            saved_at: None,
        };
        
        // 4. Serialize and write credentials
        let creds_json = serde_json::to_string_pretty(&creds)
            .map_err(|e| format!("Failed to serialize credentials: {}", e))?;
        tokio::fs::write(&wechat_creds_path, creds_json).await
            .map_err(|e| format!("Failed to write credentials file: {}", e))?;
            
        // 5. Setup BotOptions
        let on_error = Box::new(move |err: &wechatbot::error::WeChatBotError| {
            error!("WeChatBot error: {}", err);
        });
        
        let opts = BotOptions {
            base_url,
            cred_path: Some(wechat_creds_path.to_string_lossy().to_string()),
            on_qr_url: None,
            on_error: Some(on_error),
        };
        
        let bot = Arc::new(WeChatBot::new(opts));
        
        // 6. Register message handler
        let event_tx_msg = self.event_tx.clone();
        bot.on_message(Box::new(move |msg| {
            info!("Received WeChat message: {:?}", msg);
            let incoming = IncomingMessage {
                id: msg.raw.client_id.clone(),
                platform: "weixin".to_string(),
                chat_id: msg.user_id.clone(),
                user_id: msg.user_id.clone(),
                user_name: "WeChat User".to_string(),
                content: MessageContent::Text(msg.text.clone()),
                timestamp: msg.timestamp.duration_since(std::time::SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64,
            };
            let _ = event_tx_msg.send(SidecarEvent::IncomingMessage(incoming));
        })).await;
        
        // 7. Login without force (loads credentials from file)
        match bot.login(false).await {
            Ok(_) => {
                info!("WeChat login succeeded via stored credentials");
                *self.status.write() = PluginStatus::Connected;
            }
            Err(e) => {
                error!("WeChat login failed via stored credentials: {}", e);
                *self.status.write() = PluginStatus::Error;
                return Err(format!("Login failed: {}", e));
            }
        }
        
        {
            let mut bot_guard = self.bot.write().await;
            *bot_guard = Some(bot.clone());
        }
        
        // 8. Start polling loop
        let status_clone = self.status.clone();
        let bot_clone = bot.clone();
        let poll_handle = tokio::spawn(async move {
            if let Err(e) = bot_clone.run().await {
                error!("WeChat bot run loop error: {}", e);
                *status_clone.write() = PluginStatus::Error;
            }
        });
        
        {
            let mut task_guard = self.poll_task.lock().await;
            *task_guard = Some(poll_handle);
        }
        
        Ok(())
    }

    async fn stop(&self) -> Result<(), String> {
        self.stop_internal().await;
        Ok(())
    }

    async fn send_message(&self, chat_id: &str, msg: OutgoingMessage) -> Result<String, String> {
        info!("WeChat send_message called for chat_id={}: {:?}", chat_id, msg);
        
        let cleaned_text = strip_html(&msg.text);
        let trimmed = cleaned_text.trim();
        
        // Update/Store draft
        if !trimmed.is_empty() && trimmed != "⏳ Thinking..." {
            let mut drafts_guard = self.drafts.write();
            drafts_guard.insert(chat_id.to_string(), cleaned_text.clone());
        }
        
        if !msg.is_streaming_update {
            // Get final text to send
            let final_text = {
                let mut drafts_guard = self.drafts.write();
                drafts_guard.remove(chat_id).unwrap_or(cleaned_text)
            };
            
            let trimmed_final = final_text.trim();
            if !trimmed_final.is_empty() && trimmed_final != "⏳ Thinking..." {
                // Send it to WeChat using bot
                let bot_guard = self.bot.read().await;
                if let Some(ref bot) = *bot_guard {
                    bot.send(chat_id, trimmed_final).await
                        .map_err(|e| format!("WeChat send failed: {}", e))?;
                } else {
                    return Err("WeChat bot not initialized".to_string());
                }
            }
        }
        
        Ok(format!("weixin_msg_{}", chat_id))
    }

    async fn edit_message(&self, chat_id: &str, _msg_id: &str, msg: OutgoingMessage) -> Result<(), String> {
        info!("WeChat edit_message called for chat_id={}: {:?}", chat_id, msg);
        
        let cleaned_text = strip_html(&msg.text);
        let trimmed = cleaned_text.trim();
        
        // Update/Store draft
        if !trimmed.is_empty() && trimmed != "⏳ Thinking..." {
            let mut drafts_guard = self.drafts.write();
            drafts_guard.insert(chat_id.to_string(), cleaned_text.clone());
        }
        
        if !msg.is_streaming_update {
            // Get final text to send
            let final_text = {
                let mut drafts_guard = self.drafts.write();
                drafts_guard.remove(chat_id).unwrap_or(cleaned_text)
            };
            
            let trimmed_final = final_text.trim();
            if !trimmed_final.is_empty() && trimmed_final != "⏳ Thinking..." {
                // Send it to WeChat using bot
                let bot_guard = self.bot.read().await;
                if let Some(ref bot) = *bot_guard {
                    bot.send(chat_id, trimmed_final).await
                        .map_err(|e| format!("WeChat send failed: {}", e))?;
                } else {
                    return Err("WeChat bot not initialized".to_string());
                }
            }
        }
        
        Ok(())
    }

    fn status(&self) -> PluginStatus {
        *self.status.read()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_html() {
        assert_eq!(strip_html("<p>Hello World</p>"), "Hello World");
        assert_eq!(strip_html("Hello <strong>World</strong>!"), "Hello World!");
        assert_eq!(strip_html("<a href='something'>Link</a>"), "Link");
        assert_eq!(strip_html("No HTML"), "No HTML");
    }

    #[test]
    fn test_generate_qr_svg_base64() {
        let res = generate_qr_svg_base64("https://ilink.weixin.qq.com/abc");
        assert!(res.is_ok());
        let val = res.unwrap();
        assert!(val.starts_with("data:image/svg+xml;base64,"));
    }
}
