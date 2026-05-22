use std::sync::Arc;
use crate::gateway::Gateway;
use crate::domain::CreateConversationInput;

#[derive(Clone)]
pub struct ImSessionManager {
    gateway: Arc<Gateway>,
}

impl ImSessionManager {
    pub fn new(gateway: Arc<Gateway>) -> Self {
        Self { gateway }
    }

    pub async fn get_or_create_conversation(
        &self,
        platform: &str,
        chat_id: &str,
    ) -> Result<String, String> {
        let db = &self.gateway.db;
        let (workspace_id, agent_profile_id) = {
            let conn = db.conn.lock();

            // 1. Check if conversation already exists for this channel_chat_id and source
            let mut stmt = conn
                .prepare(
                    "SELECT id FROM conversations WHERE source = ?1 AND channel_chat_id = ?2 LIMIT 1",
                )
                .map_err(|e| e.to_string())?;

            let existing_id: Option<String> = stmt
                .query_row([platform, chat_id], |row| row.get(0))
                .ok();

            if let Some(id) = existing_id {
                return Ok(id);
            }

            // 2. Query configuration from im_plugins to check for custom workspace/agent bindings
            let mut stmt = conn
                .prepare("SELECT config_json FROM im_plugins WHERE plugin_type = ?1 LIMIT 1")
                .map_err(|e| e.to_string())?;
            
            let config_json_str: Option<String> = stmt
                .query_row([platform], |row| row.get(0))
                .ok();

            // 3. Find default enabled agent profile
            let mut stmt = conn
                .prepare("SELECT id FROM agent_profiles WHERE enabled = 1 LIMIT 1")
                .map_err(|e| e.to_string())?;
            
            let default_agent_profile_id: String = stmt
                .query_row([], |row| row.get(0))
                .map_err(|_| "No enabled agent profile found. Please configure an agent first.".to_string())?;

            // 4. Find default workspace
            let mut stmt = conn
                .prepare("SELECT id FROM workspaces LIMIT 1")
                .map_err(|e| e.to_string())?;
            
            let default_workspace_id: String = stmt
                .query_row([], |row| row.get(0))
                .map_err(|_| "No workspace found. Please bootstrap a workspace first.".to_string())?;

            let mut final_workspace_id = default_workspace_id;
            let mut final_agent_profile_id = default_agent_profile_id;

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
                }
            }

            (final_workspace_id, final_agent_profile_id)
        };

        // 5. Create conversation via gateway
        let input = CreateConversationInput {
            workspace_id,
            agent_profile_id,
            title: Some(format!("IM Chat ({})", chat_id)),
        };

        let conv_state = self
            .gateway
            .create_conversation(input)
            .await
            .map_err(|e| format!("Failed to create conversation: {}", e))?;

        let conv_id = conv_state.conversation.id;

        // 5. Update the conversation source and channel_chat_id
        let conn = db.conn.lock();
        conn.execute(
            "UPDATE conversations SET source = ?1, channel_chat_id = ?2 WHERE id = ?3",
            rusqlite::params![platform, chat_id, conv_id],
        )
        .map_err(|e| e.to_string())?;

        Ok(conv_id)
    }
}
