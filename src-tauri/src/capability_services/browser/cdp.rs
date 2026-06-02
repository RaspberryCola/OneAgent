use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use futures_util::{stream::SplitSink, SinkExt, StreamExt};

type WsSender = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;

#[derive(Debug)]
struct CdpInner {
    port: u16,
    sender: Option<WsSender>,
    pending_responses: HashMap<i64, oneshot::Sender<Value>>,
    session_id: Option<String>,
    ws_url: Option<String>,
    command_id: i64,
    /// Handle to the task that pumps ws frames into `pending_responses`.
    /// Stored so we can abort it before spawning a replacement on reconnect
    /// (otherwise old receiver tasks leak and contend on the inner lock).
    receiver_handle: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone)]
pub struct CdpClient {
    inner: Arc<Mutex<CdpInner>>,
}

#[derive(Debug, Deserialize)]
struct CdpTarget {
    #[serde(rename = "webSocketDebuggerUrl")]
    websocket_debugger_url: Option<String>,
    #[serde(rename = "type")]
    target_type: Option<String>,
    #[allow(dead_code)]
    url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ScreenshotResult {
    pub base64_png: String,
    pub current_url: Option<String>,
    pub page_title: Option<String>,
}

impl CdpClient {
    pub fn new(port: u16) -> Self {
        Self {
            inner: Arc::new(Mutex::new(CdpInner {
                port,
                sender: None,
                pending_responses: HashMap::new(),
                session_id: None,
                ws_url: None,
                command_id: 0,
                receiver_handle: None,
            })),
        }
    }

    /// Establish persistent WebSocket connection to CDP
    pub async fn connect(&self) -> Result<(), String> {
        // If a previous receiver task is still around (e.g. connect was called
        // twice), abort it before we replace it.
        {
            let mut inner = self.inner.lock().await;
            if let Some(handle) = inner.receiver_handle.take() {
                handle.abort();
            }
        }

        let ws_url = self.discover_ws_url().await?;

        let (ws, _) = connect_async(&ws_url)
            .await
            .map_err(|e| format!("CDP WebSocket connect failed: {e}"))?;

        let (ws_sender, mut receiver) = ws.split();

        let mut inner = self.inner.lock().await;
        inner.sender = Some(ws_sender);
        inner.ws_url = Some(ws_url);

        // Attach to target to get sessionId
        let attach_id = inner.next_command_id();
        let attach_msg = serde_json::json!({
            "id": attach_id,
            "method": "Target.attachToTarget",
            "params": {
                "flatten": true
            }
        });

        // Create response channel
        let (tx, rx) = oneshot::channel();
        inner.pending_responses.insert(attach_id, tx);

        // Send attach command
        if let Some(ref mut sender) = inner.sender {
            sender
                .send(Message::Text(attach_msg.to_string()))
                .await
                .map_err(|e| format!("CDP send attach failed: {e}"))?;
        }
        drop(inner);

        // Spawn receiver task to handle responses
        let cdp_inner = self.inner.clone();
        let receiver_handle = tokio::spawn(async move {
            while let Some(msg) = receiver.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Ok(val) = serde_json::from_str::<Value>(&text) {
                            let mut guard = cdp_inner.lock().await;
                            if let Some(id) = val.get("id").and_then(|v| v.as_i64()) {
                                if let Some(tx) = guard.pending_responses.remove(&id) {
                                    let _ = tx.send(val);
                                }
                            }
                        }
                    }
                    Ok(Message::Close(_)) => break,
                    Err(_) => break,
                    _ => {}
                }
            }
        });

        {
            let mut inner = self.inner.lock().await;
            inner.receiver_handle = Some(receiver_handle);
        }

        // Wait for attach response
        let response = match tokio::time::timeout(
            std::time::Duration::from_secs(5),
            rx
        ).await {
            Ok(Ok(resp)) => resp,
            Ok(Err(_)) => {
                // Channel closed before response — clean up leaked resources
                self.disconnect().await;
                return Err("CDP attach channel closed".to_string());
            }
            Err(_) => {
                // 5s timeout elapsed — clean up leaked WebSocket + receiver task
                self.disconnect().await;
                return Err("CDP attach timeout".to_string());
            }
        };

        // Extract sessionId
        if let Some(sid) = response.get("result").and_then(|r| r.get("sessionId")).and_then(|s| s.as_str()) {
            let mut inner = self.inner.lock().await;
            inner.session_id = Some(sid.to_string());
        }

        Ok(())
    }

    /// Disconnect from CDP
    pub async fn disconnect(&self) {
        let mut inner = self.inner.lock().await;
        if let Some(handle) = inner.receiver_handle.take() {
            handle.abort();
        }
        inner.sender = None;
        inner.session_id = None;
        inner.ws_url = None;
        inner.pending_responses.clear();
    }

    /// Check if connected
    pub async fn is_connected(&self) -> bool {
        self.inner.lock().await.sender.is_some()
    }

    /// Reconnect to the currently active page target.
    /// This is needed because MCP tools may navigate to a different page/tab
    /// than what this CDP client is currently connected to.
    pub async fn reconnect_to_active_page(&self) -> Result<(), String> {
        let ws_url = self.discover_ws_url().await?;
        let current_ws_url = self.inner.lock().await.ws_url.clone();

        // Only reconnect if the target has changed
        if Some(&ws_url) == current_ws_url.as_ref() && self.is_connected().await {
            return Ok(());
        }

        // Disconnect and reconnect
        self.disconnect().await;

        let (ws, _) = connect_async(&ws_url)
            .await
            .map_err(|e| format!("CDP WebSocket reconnect failed: {e}"))?;

        let (ws_sender, mut receiver) = ws.split();

        let mut inner = self.inner.lock().await;
        inner.sender = Some(ws_sender);
        inner.ws_url = Some(ws_url);

        // Attach to target
        let attach_id = inner.next_command_id();
        let attach_msg = serde_json::json!({
            "id": attach_id,
            "method": "Target.attachToTarget",
            "params": { "flatten": true }
        });

        let (tx, rx) = oneshot::channel();
        inner.pending_responses.insert(attach_id, tx);

        if let Some(ref mut sender) = inner.sender {
            sender
                .send(Message::Text(attach_msg.to_string()))
                .await
                .map_err(|e| format!("CDP send attach failed: {e}"))?;
        }
        drop(inner);

        // Spawn receiver task and remember the handle so we can abort it
        // on the next reconnect (or disconnect). `disconnect()` above already
        // aborted any previous handle.
        let cdp_inner = self.inner.clone();
        let receiver_handle = tokio::spawn(async move {
            while let Some(msg) = receiver.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Ok(val) = serde_json::from_str::<Value>(&text) {
                            let mut guard = cdp_inner.lock().await;
                            if let Some(id) = val.get("id").and_then(|v| v.as_i64()) {
                                if let Some(tx) = guard.pending_responses.remove(&id) {
                                    let _ = tx.send(val);
                                }
                            }
                        }
                    }
                    Ok(Message::Close(_)) => break,
                    Err(_) => break,
                    _ => {}
                }
            }
        });

        {
            let mut inner = self.inner.lock().await;
            inner.receiver_handle = Some(receiver_handle);
        }

        let response = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            rx
        )
        .await
        .map_err(|_| "CDP attach timeout".to_string())?
        .map_err(|_| "CDP attach channel closed".to_string())?;

        if let Some(sid) = response.get("result").and_then(|r| r.get("sessionId")).and_then(|s| s.as_str()) {
            let mut inner = self.inner.lock().await;
            inner.session_id = Some(sid.to_string());
        }

        Ok(())
    }

    /// Send a CDP command and wait for response
    async fn send_command(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut inner = self.inner.lock().await;

        let id = inner.next_command_id();
        let session_id = inner.session_id.clone();

        let mut msg = serde_json::json!({
            "id": id,
            "method": method,
            "params": params
        });

        if let Some(ref sid) = session_id {
            msg["sessionId"] = Value::String(sid.clone());
        }

        // Create response channel
        let (tx, rx) = oneshot::channel();
        inner.pending_responses.insert(id, tx);

        // Send command
        let sender = inner.sender.as_mut().ok_or("CDP not connected")?;
        sender
            .send(Message::Text(msg.to_string()))
            .await
            .map_err(|e| format!("CDP send failed: {e}"))?;
        drop(inner);

        // Wait for response
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            rx
        )
        .await
        .map_err(|_| format!("CDP command timeout: {method}"))?
        .map_err(|_| format!("CDP command channel closed: {method}"))?;

        // Check for error
        if let Some(error) = response.get("error") {
            return Err(format!("CDP error: {}", error));
        }

        Ok(response)
    }

    /// Capture a screenshot of the current page
    pub async fn capture_screenshot(&self) -> Result<ScreenshotResult, String> {
        // Get current URL
        let url_result = self.evaluate("window.location.href").await?;
        let current_url = url_result.as_str().map(|s| s.to_string());

        // Get page title
        let title_result = self.evaluate("document.title").await?;
        let page_title = title_result.as_str().map(|s| s.to_string());

        // Capture screenshot
        let response = self.send_command(
            "Page.captureScreenshot",
            serde_json::json!({
                "format": "png",
                "quality": 80
            })
        ).await?;

        let base64_png = response
            .get("result")
            .and_then(|r| r.get("data"))
            .and_then(|d| d.as_str())
            .unwrap_or("")
            .to_string();

        if base64_png.is_empty() {
            return Err("CDP screenshot returned empty data".to_string());
        }

        Ok(ScreenshotResult {
            base64_png,
            current_url,
            page_title,
        })
    }

    /// Navigate to a URL
    pub async fn navigate(&self, url: &str) -> Result<(), String> {
        self.send_command(
            "Page.navigate",
            serde_json::json!({
                "url": url
            })
        ).await?;
        Ok(())
    }

    /// Execute JavaScript expression
    pub async fn evaluate(&self, expression: &str) -> Result<Value, String> {
        let response = self.send_command(
            "Runtime.evaluate",
            serde_json::json!({
                "expression": expression,
                "returnByValue": true
            })
        ).await?;

        response
            .get("result")
            .and_then(|r| r.get("result"))
            .cloned()
            .ok_or_else(|| "CDP evaluate returned no result".to_string())
    }

    /// Click an element by selector
    pub async fn click(&self, selector: &str) -> Result<(), String> {
        // Use JSON serialization to produce a safely-escaped JS string literal,
        // which handles newlines, control chars, backslashes, quotes, etc.
        let selector_json = serde_json::to_string(selector).map_err(|e| e.to_string())?;
        let js = format!(
            r#"
            (function() {{
                const el = document.querySelector({selector_json});
                if (!el) throw new Error('Element not found: ' + {selector_json});
                el.click();
                return true;
            }})()
            "#
        );
        self.evaluate(&js).await?;
        Ok(())
    }

    /// Fill an input field
    pub async fn fill(&self, selector: &str, value: &str) -> Result<(), String> {
        // Use JSON serialization to produce safely-escaped JS string literals,
        // which handles newlines, control chars, backslashes, quotes, etc.
        let selector_json = serde_json::to_string(selector).map_err(|e| e.to_string())?;
        let value_json = serde_json::to_string(value).map_err(|e| e.to_string())?;
        let js = format!(
            r#"
            (function() {{
                const el = document.querySelector({selector_json});
                if (!el) throw new Error('Element not found: ' + {selector_json});
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                ).set;
                nativeInputValueSetter.call(el, {value_json});
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                return true;
            }})()
            "#
        );
        self.evaluate(&js).await?;
        Ok(())
    }

    /// Scroll the page
    pub async fn scroll(&self, delta_x: i32, delta_y: i32) -> Result<(), String> {
        let js = format!(
            "window.scrollBy({}, {});",
            delta_x, delta_y
        );
        self.evaluate(&js).await?;
        Ok(())
    }

    /// Get current URL
    pub async fn get_current_url(&self) -> Result<String, String> {
        let result = self.evaluate("window.location.href").await?;
        result.as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "Failed to get URL".to_string())
    }

    /// Get page title
    pub async fn get_page_title(&self) -> Result<String, String> {
        let result = self.evaluate("document.title").await?;
        result.as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "Failed to get page title".to_string())
    }

    /// Reload the page
    pub async fn reload(&self) -> Result<(), String> {
        self.send_command("Page.reload", serde_json::json!({})).await?;
        Ok(())
    }

    /// Go back in history
    pub async fn go_back(&self) -> Result<(), String> {
        let js = "window.history.back();";
        self.evaluate(js).await?;
        Ok(())
    }

    /// Go forward in history
    pub async fn go_forward(&self) -> Result<(), String> {
        let js = "window.history.forward();";
        self.evaluate(js).await?;
        Ok(())
    }

    /// Discover the WebSocket debugger URL from the CDP HTTP endpoint
    async fn discover_ws_url(&self) -> Result<String, String> {
        let port = self.inner.lock().await.port;
        let mut stream = TcpStream::connect(format!("127.0.0.1:{port}"))
            .await
            .map_err(|e| format!("CDP TCP connect failed: {e}"))?;

        let request = format!("GET /json HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|e| format!("CDP HTTP write failed: {e}"))?;

        // Use a timeout for the entire response reading to avoid hanging
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let mut reader = BufReader::new(stream);

            // Read status line + headers until empty line. We don't need any
            // header values; the body is everything after the `\r\n\r\n`
            // separator, regardless of `Content-Length` or chunked encoding.
            let mut header_buf = Vec::new();
            let mut line = String::new();
            loop {
                line.clear();
                let bytes_read = reader
                    .read_line(&mut line)
                    .await
                    .map_err(|e| format!("CDP HTTP read failed: {e}"))?;
                if bytes_read == 0 {
                    break;
                }
                header_buf.extend_from_slice(line.as_bytes());
                if line == "\r\n" || line == "\n" {
                    break;
                }
            }

            // Whatever remains in the stream is the body. `Connection: close`
            // guarantees EOF after the response.
            let mut body_buf = Vec::new();
            reader
                .read_to_end(&mut body_buf)
                .await
                .map_err(|e| format!("CDP HTTP body read failed: {e}"))?;

            let body = std::str::from_utf8(&body_buf)
                .map_err(|e| format!("CDP HTTP body not valid UTF-8: {e}"))?;

            let targets: Vec<CdpTarget> = serde_json::from_str(body)
                .map_err(|e| format!("CDP parse targets failed: {e} (body: {body})"))?;

            // Find first page target with a WebSocket URL
            targets
                .iter()
                .find(|t| {
                    t.target_type.as_deref() == Some("page")
                        && t.websocket_debugger_url.is_some()
                })
                .or_else(|| targets.iter().find(|t| t.websocket_debugger_url.is_some()))
                .and_then(|t| t.websocket_debugger_url.clone())
                .ok_or_else(|| "No CDP target with WebSocket URL found".to_string())
        })
        .await
        .map_err(|_| "CDP HTTP /json request timed out after 5s".to_string())?
    }
}

impl CdpInner {
    fn next_command_id(&mut self) -> i64 {
        let id = self.command_id;
        self.command_id += 1;
        id
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    /// Spin up a TCP listener that replies with `response` and closes, then
    /// run `discover_ws_url` against it. The `port` is read from the
    /// listener's bound address so the test never collides with anything.
    async fn run_discover_against(response: String) -> Result<String, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral port");
        let addr: SocketAddr = listener.local_addr().expect("local_addr");
        let port = addr.port();

        let server = tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await;
                let _ = sock.write_all(response.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });

        let client = CdpClient::new(port);
        let result = client.discover_ws_url().await;
        let _ = server.await;
        result
    }

    #[tokio::test]
    async fn discover_ws_url_finds_page_target() {
        let body = r#"[{
            "id": "abc",
            "type": "page",
            "url": "about:blank",
            "webSocketDebuggerUrl": "ws://127.0.0.1:19222/devtools/page/abc"
        }]"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        let ws_url = run_discover_against(response)
            .await
            .expect("discover should succeed");
        assert_eq!(ws_url, "ws://127.0.0.1:19222/devtools/page/abc");
    }

    #[tokio::test]
    async fn discover_ws_url_finds_page_with_multi_value_header() {
        // Some CDP versions return multiple headers between status and body;
        // the parser must not get confused.
        let body = r#"[{
            "id": "x",
            "type": "page",
            "webSocketDebuggerUrl": "ws://h/p"
        }]"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Custom: a\r\nX-Other: b\r\nConnection: close\r\n\r\n{}",
            body
        );
        let ws_url = run_discover_against(response)
            .await
            .expect("discover should succeed");
        assert_eq!(ws_url, "ws://h/p");
    }

    #[tokio::test]
    async fn discover_ws_url_falls_back_to_non_page_target() {
        // No "page" target exists, but a service worker has a ws url; we
        // should still pick it up.
        let body = r#"[{
            "id": "sw1",
            "type": "service_worker",
            "webSocketDebuggerUrl": "ws://127.0.0.1:19222/devtools/browser/sw1"
        }]"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}",
            body
        );
        let ws_url = run_discover_against(response)
            .await
            .expect("discover should succeed");
        assert_eq!(ws_url, "ws://127.0.0.1:19222/devtools/browser/sw1");
    }

    #[tokio::test]
    async fn discover_ws_url_empty_targets() {
        let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n[]".to_string();
        let err = run_discover_against(response)
            .await
            .expect_err("discover should fail when no targets exist");
        assert!(err.contains("No CDP target"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn disconnect_is_idempotent() {
        // Without a real CDP server we can't easily exercise the receiver
        // task abort path, but we can at least verify that calling
        // disconnect when nothing is connected is a safe no-op.
        let client = CdpClient::new(19222);
        assert!(!client.is_connected().await);
        client.disconnect().await;
        assert!(!client.is_connected().await);
        client.disconnect().await;
    }
}
