use crate::domain::*;
use crate::storage::error::StorageResult;
use crate::storage::repositories::{
    AgentProfileRepository, BindingRepository, ConversationRepository, EventRepository,
    McpRepository, MessageRepository, PermissionRepository, SkillRepository, SnapshotRepository,
    TaskRunRepository, TerminalRepository, ToolCallRepository, WorkspaceRepository,
};
use crate::storage::Database;

// Backward-compatible facade methods for `Database`.
//
// The public `Database` API remains stable while storage implementation details
// live in repository modules.
impl Database {
    pub fn list_agent_profiles(&self) -> StorageResult<Vec<AgentProfile>> {
        AgentProfileRepository::new(&self.conn.lock()).list()
    }

    pub fn upsert_agent_profile(
        &self,
        input: UpsertAgentProfileInput,
    ) -> StorageResult<AgentProfile> {
        AgentProfileRepository::new(&self.conn.lock()).upsert(input)
    }

    pub fn update_agent_capabilities(
        &self,
        profile_id: &str,
        capabilities: &AgentCapabilities,
    ) -> StorageResult<()> {
        AgentProfileRepository::new(&self.conn.lock()).update_capabilities(profile_id, capabilities)
    }

    pub fn delete_agent_profile(&self, profile_id: &str) -> StorageResult<()> {
        AgentProfileRepository::new(&self.conn.lock()).delete(profile_id)
    }

    pub fn is_agent_profile_referenced(&self, profile_id: &str) -> StorageResult<bool> {
        AgentProfileRepository::new(&self.conn.lock()).is_referenced(profile_id)
    }

    pub fn get_agent_profile(&self, profile_id: &str) -> StorageResult<AgentProfile> {
        AgentProfileRepository::new(&self.conn.lock()).get(profile_id)
    }

    pub fn list_workspaces(&self) -> StorageResult<Vec<Workspace>> {
        WorkspaceRepository::new(&self.conn.lock()).list()
    }

    pub fn open_workspace(&self, cwd: &str) -> StorageResult<Workspace> {
        WorkspaceRepository::new(&self.conn.lock()).open(cwd)
    }

    pub fn get_workspace(&self, workspace_id: &str) -> StorageResult<Workspace> {
        WorkspaceRepository::new(&self.conn.lock()).get(workspace_id)
    }

    pub fn create_conversation(
        &self,
        workspace_id: &str,
        agent_profile_id: &str,
        origin: ConversationOrigin,
        title: String,
    ) -> StorageResult<Conversation> {
        ConversationRepository::new(&self.conn.lock()).create(
            workspace_id,
            agent_profile_id,
            origin,
            title,
        )
    }

    pub fn update_conversation_status(
        &self,
        conversation_id: &str,
        status: ConversationStatus,
    ) -> StorageResult<()> {
        ConversationRepository::new(&self.conn.lock()).update_status(conversation_id, status)
    }

    pub fn list_conversations(
        &self,
        workspace_id: &str,
        include_tasks: bool,
    ) -> StorageResult<Vec<Conversation>> {
        ConversationRepository::new(&self.conn.lock()).list(workspace_id, include_tasks)
    }

    pub fn search_conversations(
        &self,
        workspace_id: &str,
        query: &str,
        include_tasks: bool,
    ) -> StorageResult<Vec<Conversation>> {
        ConversationRepository::new(&self.conn.lock()).search(workspace_id, query, include_tasks)
    }

    pub fn get_conversation(&self, conversation_id: &str) -> StorageResult<Conversation> {
        ConversationRepository::new(&self.conn.lock()).get(conversation_id)
    }

    pub fn delete_conversation(&self, conversation_id: &str) -> StorageResult<()> {
        self.delete_conversation_atomic(conversation_id)
    }

    pub fn upsert_binding(&self, binding: &AgentSessionBinding) -> StorageResult<()> {
        BindingRepository::new(&self.conn.lock()).upsert(binding)
    }

    pub fn get_binding(&self, conversation_id: &str) -> StorageResult<Option<AgentSessionBinding>> {
        BindingRepository::new(&self.conn.lock()).get(conversation_id)
    }

    pub fn create_task_run(
        &self,
        conversation_id: &str,
        workspace_id: &str,
        agent_profile_id: &str,
        goal: &str,
    ) -> StorageResult<TaskRun> {
        TaskRunRepository::new(&self.conn.lock()).create(
            conversation_id,
            workspace_id,
            agent_profile_id,
            goal,
        )
    }

    pub fn get_task_run(&self, conversation_id: &str) -> StorageResult<Option<TaskRun>> {
        TaskRunRepository::new(&self.conn.lock()).get(conversation_id)
    }

    pub fn update_task_run(
        &self,
        conversation_id: &str,
        status: TaskRunStatus,
        result_summary: Option<&str>,
    ) -> StorageResult<()> {
        TaskRunRepository::new(&self.conn.lock()).update(conversation_id, status, result_summary)
    }

    pub fn list_task_runs(&self, workspace_id: &str) -> StorageResult<Vec<TaskRun>> {
        TaskRunRepository::new(&self.conn.lock()).list(workspace_id)
    }

    pub fn append_event(
        &self,
        conversation_id: &str,
        event_type: &str,
        payload: &serde_json::Value,
    ) -> StorageResult<RuntimeEvent> {
        EventRepository::new(&self.conn.lock()).append(conversation_id, event_type, payload)
    }

    pub fn list_events(&self, conversation_id: &str) -> StorageResult<Vec<RuntimeEvent>> {
        EventRepository::new(&self.conn.lock()).list(conversation_id)
    }

    pub fn replace_snapshot(
        &self,
        conversation_id: &str,
        snapshot_version: i64,
        state: &serde_json::Value,
        event_seq: i64,
    ) -> StorageResult<()> {
        SnapshotRepository::new(&self.conn.lock()).replace(
            conversation_id,
            snapshot_version,
            state,
            event_seq,
        )
    }

    pub fn get_snapshot(
        &self,
        conversation_id: &str,
    ) -> StorageResult<Option<ConversationSnapshot>> {
        SnapshotRepository::new(&self.conn.lock()).get(conversation_id)
    }

    pub fn upsert_message(&self, message: &MessageProjection) -> StorageResult<()> {
        MessageRepository::new(&self.conn.lock()).upsert(message)
    }

    pub fn list_messages(&self, conversation_id: &str) -> StorageResult<Vec<MessageProjection>> {
        MessageRepository::new(&self.conn.lock()).list(conversation_id)
    }

    pub fn latest_agent_text(&self, conversation_id: &str) -> StorageResult<Option<String>> {
        MessageRepository::new(&self.conn.lock()).latest_agent_text(conversation_id)
    }

    pub fn latest_diff_payload(
        &self,
        conversation_id: &str,
    ) -> StorageResult<Option<serde_json::Value>> {
        MessageRepository::new(&self.conn.lock()).latest_diff_payload(conversation_id)
    }

    pub fn upsert_tool_call(&self, call: &ToolCallProjection) -> StorageResult<()> {
        ToolCallRepository::new(&self.conn.lock()).upsert(call)
    }

    pub fn list_tool_calls(&self, conversation_id: &str) -> StorageResult<Vec<ToolCallProjection>> {
        ToolCallRepository::new(&self.conn.lock()).list(conversation_id)
    }

    pub fn count_tool_calls(&self, conversation_id: &str) -> StorageResult<usize> {
        ToolCallRepository::new(&self.conn.lock()).count(conversation_id)
    }

    pub fn record_permission_decision(&self, decision: &PermissionDecision) -> StorageResult<()> {
        PermissionRepository::new(&self.conn.lock()).record_decision(decision)
    }

    pub fn list_permissions(
        &self,
        conversation_id: &str,
    ) -> StorageResult<Vec<PermissionDecision>> {
        PermissionRepository::new(&self.conn.lock()).list_decisions(conversation_id)
    }

    pub fn upsert_pending_permission(
        &self,
        request: &PendingPermissionRequest,
    ) -> StorageResult<()> {
        PermissionRepository::new(&self.conn.lock()).upsert_pending(request)
    }

    pub fn get_pending_permission_by_tool_call(
        &self,
        conversation_id: &str,
        tool_call_id: &str,
    ) -> StorageResult<Option<PendingPermissionRequest>> {
        PermissionRepository::new(&self.conn.lock())
            .get_pending_by_tool_call(conversation_id, tool_call_id)
    }

    pub fn list_pending_permissions(
        &self,
        conversation_id: &str,
    ) -> StorageResult<Vec<PendingPermissionRequest>> {
        PermissionRepository::new(&self.conn.lock()).list_pending(conversation_id)
    }

    pub fn update_pending_permission_status(
        &self,
        request_id: &str,
        status: PendingPermissionStatus,
    ) -> StorageResult<()> {
        PermissionRepository::new(&self.conn.lock()).update_pending_status(request_id, status)
    }

    pub fn cancel_pending_permissions_for_turn(&self, conversation_id: &str) -> StorageResult<()> {
        PermissionRepository::new(&self.conn.lock()).cancel_pending_for_turn(conversation_id)
    }

    pub fn upsert_terminal(&self, terminal: &TerminalRecord) -> StorageResult<()> {
        TerminalRepository::new(&self.conn.lock()).upsert(terminal)
    }

    pub fn get_terminal_by_remote_id(
        &self,
        conversation_id: &str,
        terminal_id: &str,
    ) -> StorageResult<Option<TerminalRecord>> {
        TerminalRepository::new(&self.conn.lock()).get_by_remote_id(conversation_id, terminal_id)
    }

    pub fn list_terminals(&self, conversation_id: &str) -> StorageResult<Vec<TerminalRecord>> {
        TerminalRepository::new(&self.conn.lock()).list(conversation_id)
    }

    pub fn list_workspace_mcp(&self, workspace_id: &str) -> StorageResult<Vec<McpServerConfig>> {
        McpRepository::new(&self.conn.lock()).list_by_workspace(workspace_id)
    }

    pub fn upsert_workspace_mcp(&self, config: &McpServerConfig) -> StorageResult<()> {
        McpRepository::new(&self.conn.lock()).upsert(config)
    }

    pub fn replace_workspace_skills(
        &self,
        workspace: &Workspace,
        skills: &[SkillRecord],
    ) -> StorageResult<()> {
        SkillRepository::new(&self.conn.lock()).replace_workspace_skills(workspace, skills)
    }

    pub fn list_skills(&self) -> StorageResult<Vec<SkillRecord>> {
        SkillRepository::new(&self.conn.lock()).list()
    }
}
