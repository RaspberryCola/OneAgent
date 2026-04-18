use std::sync::Arc;

use crate::{
    domain::{
        AttachmentInput, ConversationState, CreateConversationInput, PreviewSessionConfigInput,
        PreviewSessionConfigResult, TimelineResponse,
    },
    runtime::Runtime,
};

use super::ApplicationResult;

#[derive(Clone)]
pub struct ConversationAppService {
    runtime: Arc<Runtime>,
}

impl ConversationAppService {
    pub fn new(runtime: Arc<Runtime>) -> Self {
        Self { runtime }
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
}
