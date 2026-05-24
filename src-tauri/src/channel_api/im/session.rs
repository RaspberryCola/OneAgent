use std::sync::Arc;
use crate::gateway::Gateway;
use crate::domain::CreateConversationInput;
use crate::domain::SetModelInput;

fn build_conversation_title(text: &str) -> String {
    let normalized: String = text
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");

    if normalized.is_empty() {
        return "Untitled Chat".to_string();
    }

    let chars: Vec<char> = normalized.chars().collect();
    if chars.len() <= 60 {
        normalized
    } else {
        let mut sliced: String = chars[..60].iter().collect();
        sliced = sliced.trim_end().to_string();
        format!("{}...", sliced)
    }
}

#[derive(Clone)]
pub struct ImSessionManager {
    gateway: Arc<Gateway>,
}

impl ImSessionManager {
    pub fn new(gateway: Arc<Gateway>) -> Self {
        Self { gateway }
    }

    /// Get the desired workspace_id, agent_profile_id, and model_id for a platform based on the latest configuration.
    pub fn get_desired_config(&self, platform: &str) -> Result<(String, String, Option<String>), String> {
        let db = &self.gateway.db;
        let conn = db.conn.lock();

        // 1. Find default enabled agent profile
        let mut stmt = conn
            .prepare("SELECT id FROM agent_profiles WHERE enabled = 1 LIMIT 1")
            .map_err(|e| e.to_string())?;

        let default_agent_profile_id: String = stmt
            .query_row([], |row| row.get(0))
            .map_err(|_| "No enabled agent profile found. Please configure an agent first.".to_string())?;

        // 2. Find default workspace
        let mut stmt = conn
            .prepare("SELECT id FROM workspaces WHERE archived = 0 LIMIT 1")
            .map_err(|e| e.to_string())?;

        let default_workspace_id: String = stmt
            .query_row([], |row| row.get(0))
            .map_err(|_| "No workspace found. Please bootstrap a workspace first.".to_string())?;

        // 3. Query configuration from im_plugins
        let mut stmt = conn
            .prepare("SELECT config_json FROM im_plugins WHERE plugin_type = ?1 LIMIT 1")
            .map_err(|e| e.to_string())?;

        let config_json_str: Option<String> = stmt
            .query_row([platform], |row| row.get(0))
            .ok();

        let mut final_workspace_id = default_workspace_id;
        let mut final_agent_profile_id = default_agent_profile_id;
        let mut final_model_id: Option<String> = None;

        if let Some(config_str) = config_json_str {
            if let Ok(config_json) = serde_json::from_str::<serde_json::Value>(&config_str) {
                if let Some(w_id) = config_json.get("workspace_id").and_then(|v| v.as_str()) {
                    let mut check_stmt = conn
                        .prepare("SELECT 1 FROM workspaces WHERE id = ?1")
                        .map_err(|e| e.to_string())?;
                    if check_stmt.exists([w_id]).unwrap_or(false) {
                        final_workspace_id = w_id.to_string();
                    }
                }
                if let Some(a_id) = config_json.get("agent_profile_id").and_then(|v| v.as_str()) {
                    let mut check_stmt = conn
                        .prepare("SELECT 1 FROM agent_profiles WHERE id = ?1")
                        .map_err(|e| e.to_string())?;
                    if check_stmt.exists([a_id]).unwrap_or(false) {
                        final_agent_profile_id = a_id.to_string();
                    }
                }
                if let Some(m_id) = config_json.get("model_id").and_then(|v| v.as_str()) {
                    final_model_id = Some(m_id.to_string());
                }
            }
        }

        Ok((final_workspace_id, final_agent_profile_id, final_model_id))
    }

    pub async fn get_or_create_conversation(
        &self,
        platform: &str,
        chat_id: &str,
        first_msg_text: Option<&str>,
    ) -> Result<String, String> {
        let db = &self.gateway.db;

        // Check if active conversation already exists
        let existing_info = {
            let conn = db.conn.lock();
            let mut stmt = conn
                .prepare(
                    "SELECT id, workspace_id, agent_profile_id FROM conversations WHERE source = ?1 AND channel_chat_id = ?2 AND channel_active = 1 LIMIT 1",
                )
                .map_err(|e| e.to_string())?;

            stmt.query_row([platform, chat_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            }).ok()
        };

        if let Some((id, workspace_id, agent_profile_id)) = existing_info {
            // Check if workspace and agent settings match the existing conversation
            // Note: model_id changes do NOT trigger conversation archival (same session can switch models)
            if let Ok((desired_ws_id, desired_agent_id, desired_model_id)) = self.get_desired_config(platform) {
                if workspace_id == desired_ws_id && agent_profile_id == desired_agent_id {
                    // workspace/agent match - check if model needs to be switched
                    if let Some(new_model_id) = desired_model_id {
                        // Try to get current model from conversation state
                        let current_model = self.get_conversation_current_model(&id);
                        if current_model.as_ref() != Some(&new_model_id) {
                            // Switch model in the existing session
                            let _ = self.gateway.set_model(SetModelInput {
                                conversation_id: id.clone(),
                                model_id: new_model_id,
                            }).await;
                        }
                    }
                    if let Some(text) = first_msg_text {
                        let _ = self.maybe_update_conversation_title(&id, text).await;
                    }
                    return Ok(id);
                } else {
                    // workspace or agent mismatch - archive old and create new
                    return self.archive_and_create_new(platform, chat_id, first_msg_text).await;
                }
            }
            if let Some(text) = first_msg_text {
                let _ = self.maybe_update_conversation_title(&id, text).await;
            }
            return Ok(id);
        }

        self.create_im_conversation(platform, chat_id, first_msg_text).await
    }

    /// Archive the current active conversation and create a new one.
    /// Used by the `/new` command.
    pub async fn archive_and_create_new(
        &self,
        platform: &str,
        chat_id: &str,
        first_msg_text: Option<&str>,
    ) -> Result<String, String> {
        let db = &self.gateway.db;

        // Archive existing active conversation
        {
            let conn = db.conn.lock();
            conn.execute(
                "UPDATE conversations SET channel_active = 0 WHERE source = ?1 AND channel_chat_id = ?2 AND channel_active = 1",
                rusqlite::params![platform, chat_id],
            ).map_err(|e| e.to_string())?;
        }

        // Create new conversation with latest config
        self.create_im_conversation(platform, chat_id, first_msg_text).await
    }

    /// Switch the workspace for a platform and create a new conversation.
    /// Used by the `/switch <workspace>` command.
    pub async fn switch_workspace(
        &self,
        platform: &str,
        chat_id: &str,
        workspace_id: &str,
    ) -> Result<String, String> {
        let db = &self.gateway.db;

        // Validate workspace exists
        {
            let conn = db.conn.lock();
            let mut stmt = conn.prepare("SELECT 1 FROM workspaces WHERE id = ?1 AND archived = 0")
                .map_err(|e| e.to_string())?;
            if !stmt.exists([workspace_id]).unwrap_or(false) {
                return Err("Workspace not found".to_string());
            }
        }

        // Update plugin config with new workspace
        let agent_model_ids = {
            let conn = db.conn.lock();
            let config_str: Option<String> = conn.query_row(
                "SELECT config_json FROM im_plugins WHERE plugin_type = ?1",
                [platform],
                |row| row.get(0),
            ).ok().flatten();

            let mut config_val = if let Some(s) = config_str {
                serde_json::from_str::<serde_json::Value>(&s).unwrap_or(serde_json::json!({}))
            } else {
                serde_json::json!({})
            };

            let a_id = config_val.get("agent_profile_id").and_then(|v| v.as_str()).map(|s| s.to_string());
            let m_id = config_val.get("model_id").and_then(|v| v.as_str()).map(|s| s.to_string());

            config_val["workspace_id"] = serde_json::Value::String(workspace_id.to_string());
            let now = chrono::Utc::now().timestamp();
            conn.execute(
                "UPDATE im_plugins SET config_json = ?1, updated_at = ?2 WHERE plugin_type = ?3",
                rusqlite::params![config_val.to_string(), now, platform],
            ).map_err(|e| e.to_string())?;

            (a_id, m_id)
        };

        // Archive old and create new
        let new_conv_id = self.archive_and_create_new(platform, chat_id, None).await?;

        // Broadcast config changed event so frontend and other parts stay in sync
        let (agent_profile_id, model_id) = agent_model_ids;
        self.gateway.runtime.event_bus.broadcast(
            "im:plugin_config_changed",
            &serde_json::json!({
                "platform": platform,
                "workspace_id": workspace_id,
                "agent_profile_id": agent_profile_id,
                "model_id": model_id,
            }),
        );

        Ok(new_conv_id)
    }

    /// List all available (non-archived) workspaces.
    /// Returns (id, display_name) pairs.
    pub fn list_available_workspaces(&self) -> Result<Vec<(String, String)>, String> {
        let db = &self.gateway.db;
        let conn = db.conn.lock();
        let mut stmt = conn.prepare("SELECT id, display_name FROM workspaces WHERE archived = 0 ORDER BY display_name")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for row in rows {
            if let Ok(r) = row {
                result.push(r);
            }
        }
        Ok(result)
    }

    /// Get current channel status: (conversation_id, workspace_name, agent_name).
    pub fn get_channel_status(
        &self,
        platform: &str,
        chat_id: &str,
    ) -> Result<(String, String, String), String> {
        let db = &self.gateway.db;
        let conn = db.conn.lock();

        let result: Option<(String, String, String)> = conn.query_row(
            "SELECT c.id, w.display_name, a.name \
             FROM conversations c \
             JOIN workspaces w ON c.workspace_id = w.id \
             JOIN agent_profiles a ON c.agent_profile_id = a.id \
             WHERE c.source = ?1 AND c.channel_chat_id = ?2 AND c.channel_active = 1 \
             LIMIT 1",
            rusqlite::params![platform, chat_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).ok();

        match result {
            Some(r) => Ok(r),
            None => Err("No active conversation".to_string()),
        }
    }

    /// Get the current model_id for a conversation from its config_options.
    fn get_conversation_current_model(&self, conversation_id: &str) -> Option<String> {
        // Try to get from conversation_state JSON in database
        let db = &self.gateway.db;
        let conn = db.conn.lock();

        let state_json: Option<String> = conn.query_row(
            "SELECT state_json FROM conversation_states WHERE conversation_id = ?1",
            [conversation_id],
            |row| row.get(0)
        ).ok().flatten();

        if let Some(json_str) = state_json {
            if let Ok(state) = serde_json::from_str::<serde_json::Value>(&json_str) {
                // Look for model in config_options
                if let Some(config_options) = state.get("config_options").and_then(|v| v.as_array()) {
                    for opt in config_options {
                        if opt.get("category").and_then(|v| v.as_str()) == Some("model") {
                            return opt.get("current_value").and_then(|v| v.as_str()).map(|s| s.to_string());
                        }
                    }
                }
                // Also check models.current_model_id
                if let Some(models) = state.get("models") {
                    return models.get("current_model_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                }
            }
        }

        None
    }

    /// Internal: Create a new IM conversation using latest plugin config.
    async fn create_im_conversation(
        &self,
        platform: &str,
        chat_id: &str,
        first_msg_text: Option<&str>,
    ) -> Result<String, String> {
        let db = &self.gateway.db;
        let (workspace_id, agent_profile_id, model_id) = self.get_desired_config(platform)?;

        let title = match first_msg_text {
            Some(text) => build_conversation_title(text),
            None => "New conversation".to_string(),
        };

        tracing::info!(
            "create_im_conversation: platform={}, chat_id={}, first_msg_text={:?}, selected_title={}",
            platform, chat_id, first_msg_text, title
        );

        // Create conversation via gateway
        let input = CreateConversationInput {
            workspace_id,
            agent_profile_id,
            title: Some(title),
        };

        let conv_state = self
            .gateway
            .create_conversation(input)
            .await
            .map_err(|e| format!("Failed to create conversation: {}", e))?;

        let conv_id = conv_state.conversation.id;

        // Update the conversation source and channel_chat_id
        {
            let conn = db.conn.lock();
            conn.execute(
                "UPDATE conversations SET source = ?1, channel_chat_id = ?2 WHERE id = ?3",
                rusqlite::params![platform, chat_id, conv_id],
            )
            .map_err(|e| e.to_string())?;
        }

        tracing::info!("create_im_conversation: successfully created and bound conversation id={}", conv_id);

        // Set model if configured
        if let Some(m_id) = model_id {
            let _ = self.gateway.set_model(SetModelInput {
                conversation_id: conv_id.clone(),
                model_id: m_id,
            }).await;
            tracing::info!("create_im_conversation: set model for conversation id={}", conv_id);
        }

        Ok(conv_id)
    }

    /// Automatically update conversation title if it's currently a default title
    /// (e.g. "New conversation", "Untitled Chat", or "IM Chat...").
    async fn maybe_update_conversation_title(&self, conv_id: &str, text: &str) -> Result<(), String> {
        let db = &self.gateway.db;
        let mut title_updated = false;

        tracing::info!("maybe_update_conversation_title: checking title for conv_id={}, text={}", conv_id, text);

        {
            let conn = db.conn.lock();

            let title: Option<String> = conn.query_row(
                "SELECT title FROM conversations WHERE id = ?1",
                [conv_id],
                |row| row.get(0)
            ).ok();

            tracing::info!("maybe_update_conversation_title: current title in db={:?}", title);

            if let Some(title) = title {
                let trimmed = title.trim();
                let lower_title = trimmed.to_lowercase();
                if lower_title == "new conversation" 
                    || lower_title == "untitled chat" 
                    || lower_title.starts_with("im chat") 
                {
                    let new_title = build_conversation_title(text);
                    tracing::info!("maybe_update_conversation_title: updating title from {:?} to {:?}", title, new_title);
                    match conn.execute(
                        "UPDATE conversations SET title = ?1 WHERE id = ?2",
                        rusqlite::params![new_title, conv_id],
                    ) {
                        Ok(_) => {
                            title_updated = true;
                            tracing::info!("maybe_update_conversation_title: title updated successfully in db");
                        }
                        Err(e) => {
                            tracing::error!("maybe_update_conversation_title: failed to execute UPDATE SQL: {}", e);
                        }
                    }
                } else {
                    tracing::info!("maybe_update_conversation_title: title does not match default pattern, no update needed");
                }
            }
        }

        if title_updated {
            tracing::info!("maybe_update_conversation_title: emitting conversation state for {}", conv_id);
            if let Err(e) = self.gateway.runtime.emit_conversation_state(conv_id) {
                tracing::error!("maybe_update_conversation_title: failed to emit state: {:?}", e);
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;
    use crate::gateway::Gateway;
    use crate::domain::{
        AgentKind, AgentLaunchMode, AgentDisplaySource, Conversation, ConversationOrigin,
        ConversationStatus, AgentSessionBinding, AgentSessionSource, ConversationState,
        ConversationRuntimeState, ConnectionPhase, SessionPhase, TurnPhase,
    };
    use std::sync::Arc;
    use std::collections::BTreeMap;
    use chrono::Utc;
    use uuid::Uuid;
    use serde_json::json;
    use crate::runtime::snapshot_model::RuntimeSnapshotState;

    fn build_conversation(id: &str, title: &str) -> Conversation {
        let now = Utc::now();
        Conversation {
            id: id.to_string(),
            workspace_id: "ws_1".to_string(),
            agent_profile_id: "profile_1".to_string(),
            origin: ConversationOrigin::OneagentManaged,
            status: ConversationStatus::Initializing,
            title: title.to_string(),
            created_at: now,
            updated_at: now,
            last_event_seq: 0,
            source: "weixin".to_string(),
            channel_chat_id: Some("user_123".to_string()),
        }
    }

    fn build_binding(conversation_id: &str) -> AgentSessionBinding {
        AgentSessionBinding {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            adapter_kind: AgentKind::Acp,
            remote_session_id: "remote_1".to_string(),
            cwd: "/tmp".to_string(),
            load_supported: true,
            source: AgentSessionSource::New,
            last_synced_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn test_maybe_update_conversation_title() {
        let db = Database::new_in_memory().unwrap();
        
        // 1. Seed agent profile
        db.upsert_agent_profile(crate::domain::UpsertAgentProfileInput {
            id: Some("profile_1".to_string()),
            kind: AgentKind::Compat,
            name: "p".to_string(),
            command: "agent".to_string(),
            args: vec![],
            env: BTreeMap::new(),
            launch_mode: AgentLaunchMode::Native,
            runtime_preference: None,
            package_name: None,
            package_version: None,
            display_source: AgentDisplaySource::Native,
            enabled: true,
        }).unwrap();

        // 2. Seed workspace
        let ws = db.open_workspace("/tmp").unwrap();

        // 3. Create Gateway & ImSessionManager
        let gateway = Arc::new(Gateway::new(db.clone()).unwrap());
        let session_mgr = ImSessionManager::new(gateway.clone());

        // 4. Directly insert a conversation with default title
        let conv_id = "conv_test_1";
        let conversation = Conversation {
            workspace_id: ws.id.clone(),
            ..build_conversation(conv_id, "New conversation")
        };
        let binding = build_binding(conv_id);
        let state = ConversationState {
            conversation: conversation.clone(),
            runtime: ConversationRuntimeState {
                connection_phase: ConnectionPhase::Ready,
                session_phase: SessionPhase::Hot,
                turn_phase: TurnPhase::Idle,
                last_error: None,
                last_transition_at: Utc::now(),
            },
            binding: Some(binding.clone()),
            task_run: None,
            config_options: vec![],
            models: None,
            modes: None,
            available_commands: Vec::new(),
            pending_permissions: vec![],
        };

        db.create_conversation_atomic(
            &conversation,
            &binding,
            "ConversationCreated",
            &json!({ "origin": "oneagent_managed" }),
            &serde_json::to_value(RuntimeSnapshotState::from_conversation_state(&state)).unwrap(),
        ).unwrap();

        // Verify initial title
        {
            let conn = db.conn.lock();
            let title: String = conn.query_row(
                "SELECT title FROM conversations WHERE id = ?1",
                [conv_id],
                |row| row.get(0)
            ).unwrap();
            assert_eq!(title, "New conversation");
        }

        // Call maybe_update_conversation_title with a new message text
        let res = session_mgr.maybe_update_conversation_title(conv_id, "Hello this is a new message content").await;
        assert!(res.is_ok());

        // Verify updated title
        {
            let conn = db.conn.lock();
            let title: String = conn.query_row(
                "SELECT title FROM conversations WHERE id = ?1",
                [conv_id],
                |row| row.get(0)
            ).unwrap();
            assert_eq!(title, "Hello this is a new message content");
        }
    }
}
