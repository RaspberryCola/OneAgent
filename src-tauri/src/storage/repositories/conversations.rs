use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::domain::{
    Conversation, ConversationOrigin, ConversationSnapshot, ConversationStatus, TaskRun,
    TaskRunStatus,
};
use crate::storage::error::{StorageError, StorageResult};
use crate::storage::mappers::conversation::read_conversation;
use crate::storage::mappers::enum_text;
use crate::storage::mappers::snapshot::read_snapshot;
use crate::storage::mappers::task_run::read_task_run;

pub struct ConversationRepository<'a> {
    conn: &'a Connection,
}

impl<'a> ConversationRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    pub fn create(
        &self,
        workspace_id: &str,
        agent_profile_id: &str,
        origin: ConversationOrigin,
        title: String,
    ) -> StorageResult<Conversation> {
        let now = Utc::now();
        let conversation = Conversation {
            id: Uuid::new_v4().to_string(),
            workspace_id: workspace_id.to_string(),
            agent_profile_id: agent_profile_id.to_string(),
            origin,
            status: ConversationStatus::Initializing,
            title,
            created_at: now,
            updated_at: now,
            last_event_seq: 0,
        };
        self.conn.execute(
            r#"
            INSERT INTO conversations (id, workspace_id, agent_profile_id, origin, status, title, created_at, updated_at, last_event_seq)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                conversation.id,
                conversation.workspace_id,
                conversation.agent_profile_id,
                enum_text(&conversation.origin),
                enum_text(&conversation.status),
                conversation.title,
                conversation.created_at.to_rfc3339(),
                conversation.updated_at.to_rfc3339(),
                conversation.last_event_seq
            ],
        )?;
        Ok(conversation)
    }

    pub fn update_status(
        &self,
        conversation_id: &str,
        status: ConversationStatus,
    ) -> StorageResult<()> {
        self.conn.execute(
            "UPDATE conversations SET status = ?2, updated_at = ?3 WHERE id = ?1",
            params![conversation_id, enum_text(&status), Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn list(
        &self,
        workspace_id: &str,
        include_tasks: bool,
    ) -> StorageResult<Vec<Conversation>> {
        let sql = if include_tasks {
            "SELECT id, workspace_id, agent_profile_id, origin, status, title, created_at, updated_at, last_event_seq FROM conversations WHERE workspace_id = ?1 ORDER BY updated_at DESC"
        } else {
            "SELECT id, workspace_id, agent_profile_id, origin, status, title, created_at, updated_at, last_event_seq FROM conversations WHERE workspace_id = ?1 AND origin != 'worker_task' ORDER BY updated_at DESC"
        };
        let conn = self.conn;
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![workspace_id], read_conversation)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn search(
        &self,
        workspace_id: &str,
        query: &str,
        include_tasks: bool,
    ) -> StorageResult<Vec<Conversation>> {
        let search_pattern = format!("%{}%", query);
        let sql = if include_tasks {
            "SELECT id, workspace_id, agent_profile_id, origin, status, title, created_at, updated_at, last_event_seq \
             FROM conversations \
             WHERE workspace_id = ?1 AND title LIKE ?2 \
             ORDER BY updated_at DESC"
        } else {
            "SELECT id, workspace_id, agent_profile_id, origin, status, title, created_at, updated_at, last_event_seq \
             FROM conversations \
             WHERE workspace_id = ?1 AND origin != 'worker_task' AND title LIKE ?2 \
             ORDER BY updated_at DESC"
        };
        let conn = self.conn;
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![workspace_id, search_pattern], read_conversation)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn get(&self, conversation_id: &str) -> StorageResult<Conversation> {
        self.conn
            
            .query_row(
                "SELECT id, workspace_id, agent_profile_id, origin, status, title, created_at, updated_at, last_event_seq FROM conversations WHERE id = ?1",
                params![conversation_id],
                read_conversation,
            )
            .map_err(|_| StorageError::NotFound(format!("conversation {conversation_id}")))
    }

    pub fn delete(&self, conversation_id: &str) -> StorageResult<()> {
        self.conn.execute(
            "DELETE FROM terminal_records WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        self.conn.execute(
            "DELETE FROM pending_permission_requests WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        self.conn.execute(
            "DELETE FROM permission_decisions WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        self.conn.execute(
            "DELETE FROM tool_call_projections WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        self.conn.execute(
            "DELETE FROM message_projections WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        self.conn.execute(
            "DELETE FROM runtime_events WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        self.conn.execute(
            "DELETE FROM conversation_snapshots WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        self.conn.execute(
            "DELETE FROM task_runs WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        self.conn.execute(
            "DELETE FROM agent_session_bindings WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        let deleted = self.conn.execute(
            "DELETE FROM conversations WHERE id = ?1",
            params![conversation_id],
        )?;
        if deleted == 0 {
            return Err(StorageError::NotFound(format!(
                "conversation {conversation_id}"
            )));
        }
        Ok(())
    }
}

pub struct TaskRunRepository<'a> {
    conn: &'a Connection,
}

impl<'a> TaskRunRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    pub fn create(
        &self,
        conversation_id: &str,
        workspace_id: &str,
        agent_profile_id: &str,
        goal: &str,
    ) -> StorageResult<TaskRun> {
        let now = Utc::now();
        let task = TaskRun {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            workspace_id: workspace_id.to_string(),
            agent_profile_id: agent_profile_id.to_string(),
            goal: goal.to_string(),
            status: TaskRunStatus::Pending,
            result_summary: None,
            created_at: now,
            updated_at: now,
        };
        self.conn.execute(
            r#"
            INSERT INTO task_runs (id, conversation_id, workspace_id, agent_profile_id, goal, status, result_summary, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                task.id,
                task.conversation_id,
                task.workspace_id,
                task.agent_profile_id,
                task.goal,
                enum_text(&task.status),
                task.result_summary,
                task.created_at.to_rfc3339(),
                task.updated_at.to_rfc3339()
            ],
        )?;
        Ok(task)
    }

    pub fn get(&self, conversation_id: &str) -> StorageResult<Option<TaskRun>> {
        self.conn
            
            .query_row(
                "SELECT id, conversation_id, workspace_id, agent_profile_id, goal, status, result_summary, created_at, updated_at FROM task_runs WHERE conversation_id = ?1",
                params![conversation_id],
                read_task_run,
            )
            .optional()
            .map_err(StorageError::from)
    }

    pub fn update(
        &self,
        conversation_id: &str,
        status: TaskRunStatus,
        result_summary: Option<&str>,
    ) -> StorageResult<()> {
        self.conn.execute(
            "UPDATE task_runs SET status = ?2, result_summary = COALESCE(?3, result_summary), updated_at = ?4 WHERE conversation_id = ?1",
            params![
                conversation_id,
                enum_text(&status),
                result_summary,
                Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn list(&self, workspace_id: &str) -> StorageResult<Vec<TaskRun>> {
        let conn = self.conn;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, workspace_id, agent_profile_id, goal, status, result_summary, created_at, updated_at FROM task_runs WHERE workspace_id = ?1 ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map(params![workspace_id], read_task_run)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }
}

pub struct SnapshotRepository<'a> {
    conn: &'a Connection,
}

impl<'a> SnapshotRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    pub fn replace(
        &self,
        conversation_id: &str,
        snapshot_version: i64,
        state: &serde_json::Value,
        event_seq: i64,
    ) -> StorageResult<()> {
        self.conn.execute(
            r#"
            INSERT INTO conversation_snapshots (conversation_id, snapshot_version, state_json, event_seq, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(conversation_id) DO UPDATE SET
              snapshot_version = excluded.snapshot_version,
              state_json = excluded.state_json,
              event_seq = excluded.event_seq,
              created_at = excluded.created_at
            "#,
            params![conversation_id, snapshot_version, state.to_string(), event_seq, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn get(&self, conversation_id: &str) -> StorageResult<Option<ConversationSnapshot>> {
        self.conn
            
            .query_row(
                "SELECT conversation_id, snapshot_version, state_json, event_seq, created_at FROM conversation_snapshots WHERE conversation_id = ?1",
                params![conversation_id],
                read_snapshot,
            )
            .optional()
            .map_err(StorageError::from)
    }
}
