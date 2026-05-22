use std::sync::{Arc, Weak};
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::oneshot;
use tracing::{info, error};
use crate::gateway::Gateway;
use crate::capability_services::terminal::TerminalManager;
use crate::channel_api::im::ImChannelManager;

pub struct WebUiManager {
    shutdown_tx: AsyncMutex<Option<oneshot::Sender<()>>>,
}

impl WebUiManager {
    pub fn new() -> Self {
        Self {
            shutdown_tx: AsyncMutex::new(None),
        }
    }

    pub async fn start(
        self: &Arc<Self>,
        gateway: Arc<Gateway>,
        terminal_manager: Arc<TerminalManager>,
        im_manager: Arc<ImChannelManager>,
        app_handle: Option<tauri::AppHandle>,
        port: u16,
        allow_remote: bool,
    ) {
        let mut lock = self.shutdown_tx.lock().await;
        if lock.is_some() {
            info!("WebUI server is already running, skipping start.");
            return;
        }

        let (tx, rx) = oneshot::channel::<()>();
        *lock = Some(tx);

        let self_weak = Arc::downgrade(self);

        tokio::spawn(async move {
            super::start_web_server(
                gateway,
                terminal_manager,
                im_manager,
                app_handle,
                port,
                allow_remote,
                rx,
            ).await;

            // When the server shuts down, clean up the sender handle in the manager
            if let Some(mgr) = self_weak.upgrade() {
                let mut lock = mgr.shutdown_tx.lock().await;
                *lock = None;
            }
        });
    }

    pub async fn stop(&self) {
        let mut lock = self.shutdown_tx.lock().await;
        if let Some(tx) = lock.take() {
            let _ = tx.send(());
            info!("Sent shutdown signal to WebUI server.");
        } else {
            info!("WebUI server is not running, skipping stop.");
        }
    }

    pub async fn is_running(&self) -> bool {
        self.shutdown_tx.lock().await.is_some()
    }
}
