use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use tokio::process::{Child, Command};

use crate::domain::{BrowserScreenshotPayload, BrowserSessionConfig, BrowserSessionStatus, BrowserState};

pub mod cdp;

use self::cdp::CdpClient;

#[derive(Clone)]
pub struct BrowserManager {
    inner: Arc<RwLock<BrowserInner>>,
}

struct BrowserInner {
    state: BrowserState,
    config: Option<BrowserSessionConfig>,
    chromium_process: Option<Child>,
    cdp_port: Option<u16>,
    current_url: Option<String>,
    page_title: Option<String>,
    error: Option<String>,
    screenshot_task_handle: Option<tokio::task::JoinHandle<()>>,
    event_emitter: Option<Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>>,
    cdp_client: Option<CdpClient>,
}

impl BrowserManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(BrowserInner {
                state: BrowserState::Stopped,
                config: None,
                chromium_process: None,
                cdp_port: None,
                current_url: None,
                page_title: None,
                error: None,
                screenshot_task_handle: None,
                event_emitter: None,
                cdp_client: None,
            })),
        }
    }

    pub fn attach_emitter(&self, emitter: Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>) {
        self.inner.write().event_emitter = Some(emitter);
    }

    pub fn status(&self) -> BrowserSessionStatus {
        let inner = self.inner.read();
        BrowserSessionStatus {
            state: inner.state.clone(),
            cdp_port: inner.cdp_port,
            current_url: inner.current_url.clone(),
            page_title: inner.page_title.clone(),
            error: inner.error.clone(),
        }
    }

    /// Generate the MCP server config for chrome-devtools-mcp pointing to our browser.
    /// Uses stdio transport — the MCP manager spawns chrome-devtools-mcp directly
    /// (no HTTP proxy needed, since rmcp does not support the legacy SSE protocol
    /// that mcp-proxy exposes).
    pub fn mcp_server_config(&self) -> Option<crate::domain::McpServerConfig> {
        let inner = self.inner.read();
        if inner.state != BrowserState::Running {
            return None;
        }
        let cdp_port = inner.cdp_port?;
        Some(crate::domain::McpServerConfig {
            id: "browser-use-internal".to_string(),
            workspace_id: String::new(),
            name: "Browser Use".to_string(),
            transport_type: crate::domain::McpTransportType::Stdio,
            command: "npx".to_string(),
            args: vec![
                "-y".to_string(),
                "chrome-devtools-mcp@latest".to_string(),
                "--browser-url".to_string(),
                format!("http://127.0.0.1:{cdp_port}"),
            ],
            url: String::new(),
            env: serde_json::json!({}),
            headers: serde_json::json!({}),
            enabled: true,
            builtin: true,
            oauth_client_id: None,
            oauth_client_secret: None,
            oauth_scopes: None,
        })
    }

    /// Always returns a config for the browser MCP, regardless of browser state.
    /// `enabled` reflects the actual running state so that `resolve_all()` (for
    /// agent usage) only includes the browser MCP when it's truly available.
    pub fn mcp_server_config_always(&self) -> crate::domain::McpServerConfig {
        let inner = self.inner.read();
        let cdp_port = inner.cdp_port;
        let is_running = inner.state == BrowserState::Running;

        let args = if is_running && cdp_port.is_some() {
            vec![
                "-y".to_string(),
                "chrome-devtools-mcp@latest".to_string(),
                "--browser-url".to_string(),
                format!("http://127.0.0.1:{}", cdp_port.unwrap()),
            ]
        } else {
            vec![
                "-y".to_string(),
                "chrome-devtools-mcp@latest".to_string(),
                "--browser-url".to_string(),
                "http://127.0.0.1:0".to_string(),
            ]
        };

        crate::domain::McpServerConfig {
            id: "browser-use-internal".to_string(),
            workspace_id: String::new(),
            name: "Browser Use".to_string(),
            transport_type: crate::domain::McpTransportType::Stdio,
            command: "npx".to_string(),
            args,
            url: String::new(),
            env: serde_json::json!({}),
            headers: serde_json::json!({}),
            // When not running, mark as disabled so resolve_all() skips it
            // for agent tool injection. list_with_builtins() overrides this
            // with the user's system_settings preference for the UI.
            enabled: is_running,
            builtin: true,
            oauth_client_id: None,
            oauth_client_secret: None,
            oauth_scopes: None,
        }
    }

    /// Start browser session with given config
    pub async fn start(&self, config: BrowserSessionConfig) -> Result<(), String> {
        {
            let inner = self.inner.read();
            if inner.state == BrowserState::Running || inner.state == BrowserState::Starting {
                return Err("Browser session already active".to_string());
            }
        }

        self.set_state(BrowserState::Starting, None, None);

        // Detect browser path
        let browser_path = match &config.browser_path {
            Some(p) => PathBuf::from(p),
            None => detect_browser().ok_or_else(|| {
                "Chrome/Chromium not found. Set CHROME_PATH or install Chrome.".to_string()
            })?,
        };

        // Assign CDP port — use 19222 to avoid conflicting with user's Chrome debugging (typically 9222)
        let preferred_port = config.cdp_port.unwrap_or(19222);
        let cdp_port = find_available_port(preferred_port).await
            .ok_or_else(|| format!("No available port found starting from {preferred_port} (tried 10 ports)"))?;

        // Use an isolated user-data-dir so this Chrome instance is fully separate
        // from the user's normal Chrome (no shared tabs, history, extensions, etc.)
        let data_dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".oneagent")
            .join("browser-profile");

        // Kill any existing Chrome processes using the same user-data-dir.
        // Without this, Chrome reuses the existing session and ignores our
        // --remote-debugging-port, resulting in CDP connection failures.
        let data_dir_str = data_dir.to_string_lossy().to_string();
        kill_chrome_with_profile(&data_dir_str).await;

        // Remove stale SingletonLock left by a previous Chrome that didn't
        // exit cleanly. Safe even if the file does not exist.
        let _ = std::fs::remove_file(data_dir.join("SingletonLock"));

        // Build chromium args
        let mut args = vec![
            format!("--remote-debugging-port={cdp_port}"),
            format!("--user-data-dir={}", data_dir.display()),
            format!("--window-size={},{}", config.viewport_width, config.viewport_height),
            "--disable-background-networking".to_string(),
            "--disable-default-apps".to_string(),
            "--disable-extensions".to_string(),
            "--disable-sync".to_string(),
            "--no-first-run".to_string(),
            "--no-default-browser-check".to_string(),
            "--remote-allow-origins=*".to_string(),
        ];
        if config.headless {
            args.push("--headless=new".to_string());
        }
        args.push("about:blank".to_string());

        // Spawn chromium
        let chromium = Command::new(&browser_path)
            .args(&args)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to spawn Chrome: {e}"))?;

        {
            let mut inner = self.inner.write();
            inner.chromium_process = Some(chromium);
            inner.cdp_port = Some(cdp_port);
            inner.config = Some(config.clone());
        }

        // Give Chrome a moment to fully initialize its CDP HTTP server
        // before the first connection attempt (avoids long HTTP timeouts).
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

        // Create persistent CDP client and connect
        tracing::info!("Browser: connecting to CDP on port {cdp_port}");
        let cdp_client = CdpClient::new(cdp_port);
        let mut retries = 0;
        loop {
            match cdp_client.connect().await {
                Ok(_) => {
                    tracing::info!("Browser: CDP connected successfully on port {cdp_port}");
                    break;
                }
                Err(e) if retries < 60 => {
                    retries += 1;
                    if retries <= 3 || retries % 10 == 0 {
                        tracing::warn!("Browser: CDP connect attempt {retries}/60 failed: {e}");
                    }
                    // Progressive delay: longer at first (Chrome may be slow to start),
                    // then shorter once we know TCP is available.
                    let delay_ms = if retries <= 5 { 500 } else { 200 };
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
                Err(e) => {
                    tracing::error!("Browser: CDP connect failed after 60 retries: {e}");
                    self.cleanup().await;
                    self.set_state(BrowserState::Error, None, Some(format!("CDP not ready: {e}")));
                    return Err(format!("Chrome CDP not ready: {e}"));
                }
            }
        }

        // Store CDP client
        {
            let mut inner = self.inner.write();
            inner.cdp_client = Some(cdp_client.clone());
        }

        // Start screenshot monitoring task only if enabled in config
        if config.enable_screenshots {
            let inner_clone = self.inner.clone();
            let screenshot_interval = config.screenshot_interval_ms;
            let handle = tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(screenshot_interval)).await;

                // Check if still running and get CDP client clone
                let cdp = {
                    let inner = inner_clone.read();
                    if inner.state != BrowserState::Running {
                        break;
                    }
                    inner.cdp_client.clone()
                };

                // Use persistent CDP client for screenshots
                if let Some(cdp) = cdp {
                    // Reconnect to active page in case MCP tools navigated elsewhere
                    if let Err(e) = cdp.reconnect_to_active_page().await {
                        tracing::debug!("Browser: reconnect failed: {e}");
                        continue;
                    }

                    match cdp.capture_screenshot().await {
                        Ok(result) => {
                            let emitter = {
                                let inner = inner_clone.read();
                                inner.event_emitter.clone()
                            };
                            if emitter.is_none() {
                                tracing::warn!("Browser: screenshot captured but no event emitter attached");
                            }
                            if let Some(emitter) = emitter {
                                let payload = BrowserScreenshotPayload {
                                    base64_png: result.base64_png.clone(),
                                    url: result.current_url.clone(),
                                    timestamp: chrono::Utc::now(),
                                };
                                if let Ok(json) = serde_json::to_value(&payload) {
                                    tracing::debug!("Browser: emitting screenshot ({} bytes)", result.base64_png.len());
                                    emitter("browser:screenshot", json);
                                }
                            }

                            // Update current URL and page title
                            {
                                let mut inner = inner_clone.write();
                                inner.current_url = result.current_url;
                                inner.page_title = result.page_title;
                            }
                        }
                        Err(e) => {
                            tracing::debug!("Browser: screenshot capture failed: {e}");
                        }
                    }
                } else {
                    tracing::debug!("Browser: no CDP client available for screenshot");
                }
            }
            });

            {
                let mut inner = self.inner.write();
                inner.screenshot_task_handle = Some(handle);
            }
        } else {
            tracing::info!("Browser: screenshots disabled, skipping screenshot task");
        }

        self.set_state(BrowserState::Running, None, None);
        tracing::info!("Browser session started on CDP port {cdp_port}");
        Ok(())
    }

    /// Stop the browser session
    pub async fn stop(&self) -> Result<(), String> {
        // Disconnect CDP client first
        let cdp = {
            let inner = self.inner.read();
            inner.cdp_client.clone()
        };
        if let Some(cdp) = cdp {
            cdp.disconnect().await;
        }

        self.cleanup().await;
        self.set_state(BrowserState::Stopped, None, None);
        Ok(())
    }

    /// Navigate to a URL
    pub async fn navigate(&self, url: &str) -> Result<(), String> {
        let cdp = {
            let inner = self.inner.read();
            if inner.state != BrowserState::Running {
                return Err("Browser not running".to_string());
            }
            inner.cdp_client.clone().ok_or("CDP client not available")?
        };
        cdp.navigate(url).await
    }

    /// Click an element by selector
    pub async fn click(&self, selector: &str) -> Result<(), String> {
        let cdp = {
            let inner = self.inner.read();
            if inner.state != BrowserState::Running {
                return Err("Browser not running".to_string());
            }
            inner.cdp_client.clone().ok_or("CDP client not available")?
        };
        cdp.click(selector).await
    }

    /// Fill an input field
    pub async fn fill(&self, selector: &str, value: &str) -> Result<(), String> {
        let cdp = {
            let inner = self.inner.read();
            if inner.state != BrowserState::Running {
                return Err("Browser not running".to_string());
            }
            inner.cdp_client.clone().ok_or("CDP client not available")?
        };
        cdp.fill(selector, value).await
    }

    /// Scroll the page
    pub async fn scroll(&self, delta_x: i32, delta_y: i32) -> Result<(), String> {
        let cdp = {
            let inner = self.inner.read();
            if inner.state != BrowserState::Running {
                return Err("Browser not running".to_string());
            }
            inner.cdp_client.clone().ok_or("CDP client not available")?
        };
        cdp.scroll(delta_x, delta_y).await
    }

    /// Execute JavaScript expression
    pub async fn evaluate_js(&self, expression: &str) -> Result<serde_json::Value, String> {
        let cdp = {
            let inner = self.inner.read();
            if inner.state != BrowserState::Running {
                return Err("Browser not running".to_string());
            }
            inner.cdp_client.clone().ok_or("CDP client not available")?
        };
        cdp.evaluate(expression).await
    }

    /// Reload the page
    pub async fn reload(&self) -> Result<(), String> {
        let cdp = {
            let inner = self.inner.read();
            if inner.state != BrowserState::Running {
                return Err("Browser not running".to_string());
            }
            inner.cdp_client.clone().ok_or("CDP client not available")?
        };
        cdp.reload().await
    }

    /// Go back in history
    pub async fn go_back(&self) -> Result<(), String> {
        let cdp = {
            let inner = self.inner.read();
            if inner.state != BrowserState::Running {
                return Err("Browser not running".to_string());
            }
            inner.cdp_client.clone().ok_or("CDP client not available")?
        };
        cdp.go_back().await
    }

    /// Go forward in history
    pub async fn go_forward(&self) -> Result<(), String> {
        let cdp = {
            let inner = self.inner.read();
            if inner.state != BrowserState::Running {
                return Err("Browser not running".to_string());
            }
            inner.cdp_client.clone().ok_or("CDP client not available")?
        };
        cdp.go_forward().await
    }

    async fn cleanup(&self) {
        let (screenshot_handle, mut chromium) = {
            let mut inner = self.inner.write();
            let handle = inner.screenshot_task_handle.take();
            let chromium = inner.chromium_process.take();
            inner.cdp_client = None;
            (handle, chromium)
        };

        if let Some(h) = screenshot_handle {
            h.abort();
        }
        if let Some(ref mut child) = chromium {
            let _ = child.kill().await;
        }
    }

    fn set_state(&self, state: BrowserState, url: Option<String>, error: Option<String>) {
        let (emitter, state_payload) = {
            let mut inner = self.inner.write();
            inner.state = state.clone();
            if url.is_some() {
                inner.current_url = url;
            }
            inner.error = error.clone();

            let payload = serde_json::json!({
                "state": state,
                "current_url": inner.current_url,
                "page_title": inner.page_title,
                "cdp_port": inner.cdp_port,
            });
            (inner.event_emitter.clone(), payload)
        };

        if let Some(emitter) = emitter {
            emitter("browser:state_changed", state_payload);
            // Notify frontend to refresh MCP list (browser state affects MCP availability)
            emitter("mcp:list_changed", serde_json::json!({}));
        }
    }
}

/// Detect installed Chrome/Chromium browser path
fn detect_browser() -> Option<PathBuf> {
    // Check environment variables first
    if let Ok(path) = std::env::var("CHROME_PATH") {
        let p = PathBuf::from(&path);
        if p.exists() {
            return Some(p);
        }
    }
    if let Ok(path) = std::env::var("CHROMIUM_PATH") {
        let p = PathBuf::from(&path);
        if p.exists() {
            return Some(p);
        }
    }

    // Platform-specific well-known paths
    #[cfg(target_os = "macos")]
    {
        let candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        ];
        for path in &candidates {
            let p = PathBuf::from(path);
            if p.exists() {
                return Some(p);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let candidates = ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"];
        for name in &candidates {
            if let Ok(p) = which::which(name) {
                return Some(p);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let p = PathBuf::from(&local)
                .join("Google/Chrome/Application/chrome.exe");
            if p.exists() {
                return Some(p);
            }
        }
        if let Some(pf) = std::env::var_os("PROGRAMFILES") {
            let p = PathBuf::from(&pf)
                .join("Google/Chrome/Application/chrome.exe");
            if p.exists() {
                return Some(p);
            }
        }
    }

    // Try which as fallback
    if let Ok(p) = which::which("google-chrome") {
        return Some(p);
    }
    if let Ok(p) = which::which("chromium") {
        return Some(p);
    }

    None
}

/// Find an available TCP port starting from `preferred`. Tries up to 10 consecutive ports.
async fn find_available_port(preferred: u16) -> Option<u16> {
    for offset in 0..10u16 {
        let port = preferred.wrapping_add(offset);
        if port == 0 {
            continue;
        }
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(_) => return Some(port),
            Err(_) => {
                tracing::debug!("Port {port} is in use, trying next");
                continue;
            }
        }
    }
    None
}

/// Kill any running Chrome/Chromium process whose command line contains
/// `data_dir_str` (the `--user-data-dir` argument). Best-effort: silently
/// ignores failures (no match, missing tool, permission denied).
///
/// On Unix, `pkill -f` matches against the full command line.
/// On Windows, `pkill` is unavailable, so we shell out to PowerShell to
/// enumerate processes by command line before killing. We deliberately
/// avoid `taskkill /IM chrome.exe` because that would also kill the
/// user's normal Chrome browser.
async fn kill_chrome_with_profile(data_dir_str: &str) {
    #[cfg(unix)]
    {
        // pkill exits 1 when nothing matches, which we treat as success.
        let _ = std::process::Command::new("pkill")
            .args(["-f", data_dir_str])
            .output();
    }

    #[cfg(windows)]
    {
        // PowerShell: find chrome.exe whose command line includes our
        // data dir, then force-kill each match. Silently continues on
        // errors so a missing PowerShell or no match is a no-op.
        let escaped = data_dir_str.replace('\'', "''");
        let script = format!(
            "$ErrorActionPreference = 'SilentlyContinue'; \
             Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" | \
             Where-Object {{ $_.CommandLine -like '*{}*' }} | \
             ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}",
            escaped
        );
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output();
    }

    // Give the OS a moment to release the SingletonLock / port. This is a
    // best-effort heuristic; if it isn't enough, the subsequent spawn of
    // Chrome will fail with a clear error and the user can retry.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
}
