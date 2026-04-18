use std::sync::Arc;

use crate::{runtime::Runtime, storage::Database};

pub mod agents;
pub mod attachments;
pub mod conversations;
pub mod permissions;
pub mod task_runs;
pub mod workspaces;

pub use agents::AgentAppService;
pub use attachments::AttachmentAppService;
pub use conversations::ConversationAppService;
pub use permissions::PermissionAppService;
pub use task_runs::TaskRunAppService;
pub use workspaces::WorkspaceAppService;

#[derive(thiserror::Error, Debug)]
pub enum ApplicationError {
    #[error("storage error: {0}")]
    Storage(#[from] crate::storage::StorageError),
    #[error("runtime error: {0}")]
    Runtime(#[from] crate::runtime::RuntimeError),
    #[error("validation error: {0}")]
    Validation(String),
}

pub type ApplicationResult<T> = Result<T, ApplicationError>;

#[derive(Clone)]
pub struct ApplicationServices {
    pub agents: AgentAppService,
    pub conversations: ConversationAppService,
    pub task_runs: TaskRunAppService,
    pub permissions: PermissionAppService,
    pub attachments: AttachmentAppService,
    pub workspaces: WorkspaceAppService,
}

impl ApplicationServices {
    pub fn new(db: Database, runtime: Arc<Runtime>) -> Self {
        let agents = AgentAppService::new(db.clone());
        Self {
            agents: agents.clone(),
            conversations: ConversationAppService::new(db.clone(), runtime.clone()),
            task_runs: TaskRunAppService::new(db.clone(), runtime.clone()),
            permissions: PermissionAppService::new(runtime.clone()),
            attachments: AttachmentAppService::new(),
            workspaces: WorkspaceAppService::new(db, runtime, agents),
        }
    }
}
