use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "value")]
pub enum MessageContent {
    Text(String),
    Command(String),
    Action(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncomingMessage {
    pub id: String,
    pub platform: String,
    pub chat_id: String,          // Isolation key
    pub user_id: String,
    pub user_name: String,
    pub content: MessageContent,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionButton {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutgoingMessage {
    pub text: String,
    pub buttons: Option<Vec<ActionButton>>,
    pub is_streaming_update: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum PluginStatus {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

#[derive(Debug, Clone)]
pub enum SidecarEvent {
    IncomingMessage(IncomingMessage),
    WeixinLoginQr(String),
    WeixinLoginScanned,
    WeixinLoginDone { account_id: String, bot_token: String },
}

#[async_trait]
pub trait ImPlugin: Send + Sync {
    fn platform(&self) -> &str;

    async fn start(&self, config: serde_json::Value) -> Result<(), String>;
    async fn stop(&self) -> Result<(), String>;

    async fn send_message(&self, chat_id: &str, msg: OutgoingMessage) -> Result<String, String>;
    async fn edit_message(&self, chat_id: &str, msg_id: &str, msg: OutgoingMessage) -> Result<(), String>;

    fn status(&self) -> PluginStatus;
}
