use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use parking_lot::RwLock;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use futures_util::{StreamExt, SinkExt};
use tracing::{debug, error, info};

use crate::runtime::event_bus::EventSink;
use super::auth::AuthService;
use crate::gateway::Gateway;

static NEXT_CLIENT_ID: AtomicUsize = AtomicUsize::new(1);

type ClientSender = mpsc::UnboundedSender<Message>;

#[derive(Clone)]
pub struct WsClients {
    clients: Arc<RwLock<HashMap<usize, ClientSender>>>,
}

impl WsClients {
    pub fn new() -> Self {
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn insert(&self, id: usize, sender: ClientSender) {
        self.clients.write().insert(id, sender);
    }

    pub fn remove(&self, id: usize) {
        self.clients.write().remove(&id);
    }

    pub fn broadcast(&self, event: &str, payload: &Value) {
        let msg = json!({
            "event": event,
            "payload": payload,
        });
        let msg_str = serde_json::to_string(&msg).unwrap_or_default();
        let clients = self.clients.read();
        for sender in clients.values() {
            let _ = sender.send(Message::Text(msg_str.clone()));
        }
    }
}

pub struct WebSocketEventSink {
    clients: WsClients,
}

impl WebSocketEventSink {
    pub fn new(clients: WsClients) -> Self {
        Self { clients }
    }
}

impl EventSink for WebSocketEventSink {
    fn emit(&self, event: &str, payload: &Value) {
        self.clients.broadcast(event, payload);
    }
}

#[derive(Deserialize)]
pub struct WsQuery {
    pub token: Option<String>,
}

#[derive(Clone)]
pub struct WebState {
    pub gateway: Arc<Gateway>,
    pub auth: AuthService,
    pub clients: WsClients,
    pub terminal_manager: Arc<crate::capability_services::terminal::TerminalManager>,
    pub im_manager: Arc<crate::channel_api::im::ImChannelManager>,
    pub app_handle: Option<tauri::AppHandle>,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<WsQuery>,
    State(state): State<WebState>,
) -> impl IntoResponse {
    // 1. Verify token
    let token = match query.token {
        Some(t) => t,
        None => return StatusCode::UNAUTHORIZED.into_response(),
    };

    if state.auth.verify_jwt(&token).is_err() {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    // 2. Upgrade to websocket
    ws.on_upgrade(move |socket| handle_websocket(socket, state))
}

async fn handle_websocket(socket: WebSocket, state: WebState) {
    let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed);
    info!("WebSocket client {} connected", client_id);

    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, rx) = mpsc::unbounded_channel();
    let mut rx = rx;

    state.clients.insert(client_id, tx);

    // Spawn a task to forward channel messages to the WebSocket
    let forward_task = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if let Err(e) = ws_sender.send(message).await {
                debug!("Error sending websocket message to client {}: {}", client_id, e);
                break;
            }
        }
    });

    // Read incoming messages from client (e.g., heartbeats or close frames)
    let clients_clone = state.clients.clone();
    let read_task = tokio::spawn(async move {
        while let Some(result) = ws_receiver.next().await {
            match result {
                Ok(msg) => {
                    match msg {
                        Message::Ping(ping) => {
                            let tx = clients_clone.clients.read().get(&client_id).cloned();
                            if let Some(sender) = tx {
                                let _ = sender.send(Message::Pong(ping));
                            }
                        }
                        Message::Close(_) => {
                            break;
                        }
                        _ => {}
                    }
                }
                Err(e) => {
                    error!("Error reading websocket message from client {}: {}", client_id, e);
                    break;
                }
            }
        }
    });

    // Wait for either the read or write task to finish/fail
    tokio::select! {
        _ = forward_task => {},
        _ = read_task => {},
    };

    // Clean up
    state.clients.remove(client_id);
    info!("WebSocket client {} disconnected", client_id);
}
