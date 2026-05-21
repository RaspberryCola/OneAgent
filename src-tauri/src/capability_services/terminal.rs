use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub struct TerminalSession {
    pub pty_pair: PtyPair,
    pub writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn spawn_session(
        &self,
        id: String,
        cwd: Option<String>,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let shell = if cfg!(target_os = "windows") {
            "powershell.exe".to_string()
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
        };

        let mut cmd = CommandBuilder::new(&shell);
        if let Some(path) = cwd {
            cmd.cwd(path);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let session = TerminalSession {
            pty_pair: pair,
            writer: Arc::new(Mutex::new(writer)),
            child,
        };

        self.sessions.lock().await.insert(id.clone(), session);

        // Read loop (spawns a blocking task to read shell output)
        let id_clone = id.clone();
        tokio::task::spawn_blocking(move || {
            let mut buf_reader = std::io::BufReader::new(reader);
            let mut buffer = [0u8; 4096];
            loop {
                use std::io::Read;
                match buf_reader.read(&mut buffer) {
                    Ok(0) => break, // EOF, process exited
                    Ok(n) => {
                        let data = &buffer[..n];
                        let text = String::from_utf8_lossy(data).into_owned();
                        let _ = app_handle.emit(
                            "terminal:output",
                            serde_json::json!({
                                "id": id_clone,
                                "data": text
                            }),
                        );
                    }
                    Err(_) => break,
                }
            }
            // Emit closed event when shell process exits
            let _ = app_handle.emit(
                "terminal:closed",
                serde_json::json!({
                    "id": id_clone
                }),
            );
        });

        Ok(())
    }

    pub async fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get(id) {
            let mut writer = session.writer.lock().await;
            writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
            writer.flush().map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("Terminal session not found".to_string())
        }
    }

    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get(id) {
            session
                .pty_pair
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("Terminal session not found".to_string())
        }
    }

    pub async fn close(&self, id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        if let Some(mut session) = sessions.remove(id) {
            let _ = session.child.kill();
            Ok(())
        } else {
            Err("Terminal session not found".to_string())
        }
    }
}
