use std::sync::Arc;

use crate::{
    domain::{ConversationState, CreateTaskRunInput, TaskRun},
    runtime::Runtime,
    storage::Database,
};

use super::ApplicationResult;

#[derive(Clone)]
pub struct TaskRunAppService {
    db: Database,
    runtime: Arc<Runtime>,
}

impl TaskRunAppService {
    pub fn new(db: Database, runtime: Arc<Runtime>) -> Self {
        Self { db, runtime }
    }

    pub async fn create_task_run(
        &self,
        input: CreateTaskRunInput,
    ) -> ApplicationResult<ConversationState> {
        Ok(self.runtime.create_task_run(input).await?)
    }

    pub fn list_task_runs(&self, workspace_id: &str) -> ApplicationResult<Vec<TaskRun>> {
        Ok(self.db.list_task_runs(workspace_id)?)
    }
}
