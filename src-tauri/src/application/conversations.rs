use std::sync::Arc;

use crate::{
    domain::{
        AcpSessionModeState, AcpSessionModels, AttachmentInput, Conversation, ConversationFilter,
        ConversationState, CreateConversationInput, PreviewSessionConfigInput,
        PreviewSessionConfigResult, SearchConversationsInput, SessionConfigInput,
        SessionConfigOption, SetModeInput, SetModelInput, TimelineResponse,
    },
    runtime::Runtime,
    storage::Database,
};

use super::{ApplicationError, ApplicationResult};

#[derive(Clone)]
pub struct ConversationAppService {
    db: Database,
    runtime: Arc<Runtime>,
}

impl ConversationAppService {
    pub fn new(db: Database, runtime: Arc<Runtime>) -> Self {
        Self { db, runtime }
    }

    pub fn list_conversations(
        &self,
        workspace_id: &str,
        filter: ConversationFilter,
    ) -> ApplicationResult<Vec<Conversation>> {
        Ok(self
            .db
            .list_conversations(workspace_id, filter.include_tasks)?)
    }

    pub fn search_conversations(
        &self,
        input: SearchConversationsInput,
    ) -> ApplicationResult<Vec<Conversation>> {
        if input.query.trim().is_empty() {
            return Err(ApplicationError::Validation(
                "search query cannot be empty".to_string(),
            ));
        }
        Ok(self
            .db
            .search_conversations(&input.workspace_id, &input.query, input.include_tasks)?)
    }

    pub async fn create_conversation(
        &self,
        input: CreateConversationInput,
    ) -> ApplicationResult<ConversationState> {
        Ok(self.runtime.create_conversation(input).await?)
    }

    pub async fn preview_session_config(
        &self,
        input: PreviewSessionConfigInput,
    ) -> ApplicationResult<PreviewSessionConfigResult> {
        Ok(self.runtime.preview_session_config(input).await?)
    }

    pub async fn import_conversation(
        &self,
        workspace_id: &str,
        agent_profile_id: &str,
        remote_session_id: &str,
    ) -> ApplicationResult<ConversationState> {
        Ok(self
            .runtime
            .import_conversation(workspace_id, agent_profile_id, remote_session_id)
            .await?)
    }

    pub async fn send_user_message(
        &self,
        conversation_id: &str,
        text: &str,
        attachments: Vec<AttachmentInput>,
    ) -> ApplicationResult<TimelineResponse> {
        if text.trim().is_empty() {
            return Err(ApplicationError::Validation(
                "message cannot be empty".to_string(),
            ));
        }
        Ok(self
            .runtime
            .send_user_message(conversation_id, text, attachments)
            .await?)
    }

    pub async fn cancel_turn(&self, conversation_id: &str) -> ApplicationResult<()> {
        Ok(self.runtime.cancel_turn(conversation_id).await?)
    }

    pub async fn delete_conversation(&self, conversation_id: &str) -> ApplicationResult<()> {
        Ok(self.runtime.delete_conversation(conversation_id).await?)
    }

    pub fn timeline(&self, conversation_id: &str) -> ApplicationResult<TimelineResponse> {
        Ok(self.runtime.timeline(conversation_id)?)
    }

    pub fn conversation_state(&self, conversation_id: &str) -> ApplicationResult<ConversationState> {
        Ok(self.runtime.conversation_state(conversation_id)?)
    }

    pub async fn set_session_config(
        &self,
        input: SessionConfigInput,
    ) -> ApplicationResult<Vec<SessionConfigOption>> {
        Ok(self.runtime.set_session_config(input).await?)
    }

    pub async fn set_model(&self, input: SetModelInput) -> ApplicationResult<AcpSessionModels> {
        Ok(self.runtime.set_model(input).await?)
    }

    pub async fn set_mode(&self, input: SetModeInput) -> ApplicationResult<AcpSessionModeState> {
        Ok(self.runtime.set_mode(input).await?)
    }
}
