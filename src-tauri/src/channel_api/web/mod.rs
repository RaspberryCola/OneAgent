pub mod auth;
pub mod ws;
pub mod handlers;
pub mod middleware;
pub mod manager;

use std::sync::Arc;
use std::net::SocketAddr;
use axum::{
    routing::{get, post},
    Router,
    middleware as axum_middleware,
};
use tower_http::cors::{CorsLayer, Any};
use tower_http::services::ServeDir;
use tracing::{info, error};

use crate::gateway::Gateway;
use crate::capability_services::terminal::TerminalManager;
use auth::AuthService;
use ws::{WsClients, WebState, ws_handler, WebSocketEventSink};
use handlers::{login_handler, logout_handler, change_password_handler, invoke_handler};
use middleware::auth_middleware;

pub async fn start_web_server(
    gateway: Arc<Gateway>,
    terminal_manager: Arc<TerminalManager>,
    im_manager: Arc<crate::channel_api::im::ImChannelManager>,
    app_handle: Option<tauri::AppHandle>,
    port: u16,
    allow_remote: bool,
    shutdown_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let auth = AuthService::new();
    let clients = WsClients::new();

    // Register WebSocket event sink to Gateway runtime event bus
    let ws_event_sink = Arc::new(WebSocketEventSink::new(clients.clone()));
    gateway.runtime.event_bus.register(ws_event_sink);

    let state = WebState {
        gateway,
        auth,
        clients,
        terminal_manager,
        im_manager,
        app_handle,
    };

    // Public API routes
    let public_routes = Router::new()
        .route("/login", post(login_handler))
        .route("/logout", post(logout_handler));

    // Auth protected API routes
    let protected_routes = Router::new()
        .route("/change-password", post(change_password_handler))
        .route("/invoke/:command", post(invoke_handler))
        .route_layer(axum_middleware::from_fn_with_state(state.clone(), auth_middleware));

    // Resolve static files directory
    let dist_dir = std::env::var("ONEAGENT_DIST_DIR")
        .unwrap_or_else(|_| {
            // When running via `tauri dev`, CWD is src-tauri/, so ../dist is the frontend build output
            let manifest_relative = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist");
            if manifest_relative.exists() {
                manifest_relative.to_string_lossy().into_owned()
            } else {
                "./dist".to_string()
            }
        });
    
    let serve_dir = ServeDir::new(&dist_dir)
        .fallback(ServeDir::new(&dist_dir));

    let app = Router::new()
        .nest("/api", Router::new().merge(public_routes).merge(protected_routes))
        .route("/ws", get(ws_handler))
        .fallback_service(serve_dir)
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_headers(Any)
                .allow_methods(Any),
        )
        .with_state(state);

    let ip = if allow_remote {
        [0, 0, 0, 0]
    } else {
        [127, 0, 0, 1]
    };
    
    let addr = SocketAddr::from((ip, port));
    info!("Starting WebUI server on {}", addr);

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            error!("Failed to bind to WebUI port {}: {}", port, e);
            return;
        }
    };

    let server = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
            info!("WebUI server shutdown signal received, shutting down gracefully.");
        });

    if let Err(e) = server.await {
        error!("WebUI axum server error: {}", e);
    }
}
