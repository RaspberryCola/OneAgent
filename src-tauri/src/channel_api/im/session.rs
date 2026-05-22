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

            // 2. We need to create a new conversation. Find an enabled agent profile.
            let mut stmt = conn
                .prepare("SELECT id FROM agent_profiles WHERE enabled = 1 LIMIT 1")
                .map_err(|e| e.to_string())?;
            
            let agent_profile_id: String = stmt
                .query_row([], |row| row.get(0))
                .map_err(|_| "No enabled agent profile found. Please configure an agent first.".to_string())?;

            // 3. Find a workspace
            let mut stmt = conn
                .prepare("SELECT id FROM workspaces LIMIT 1")
                .map_err(|e| e.to_string())?;
            
            let workspace_id: String = stmt
                .query_row([], |row| row.get(0))
                .map_err(|_| "No workspace found. Please bootstrap a workspace first.".to_string())?;

            (workspace_id, agent_profile_id)
        };

        // 4. Create conversation via gateway
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
