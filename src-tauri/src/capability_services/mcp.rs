use crate::{domain::McpServerConfig, storage::Database};

#[derive(Clone)]
pub struct McpRegistry {
    db: Database,
}

impl McpRegistry {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    pub fn list_for_workspace(
        &self,
        workspace_id: &str,
    ) -> crate::storage::StorageResult<Vec<McpServerConfig>> {
        self.db.list_workspace_mcp(workspace_id)
    }

    pub fn upsert(
        &self,
        config: McpServerConfig,
    ) -> crate::storage::StorageResult<McpServerConfig> {
        self.db.upsert_workspace_mcp(&config)?;
        Ok(config)
    }
}
