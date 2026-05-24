import { invoke } from './transport';
import type * as Types from './types';

// Agent / Workspace
export async function bootstrapWorkspace(input: Types.BootstrapWorkspaceInput): Promise<Types.WorkspaceBootstrap> {
  return invoke('bootstrap_workspace', { input });
}

export async function listAgentProfiles(): Promise<Types.AgentProfile[]> {
  return invoke('list_agent_profiles');
}

export async function listAgentDiscoveryStatus(): Promise<Types.AgentDiscoveryStatus[]> {
  return invoke('list_agent_discovery_status');
}

export async function refreshAgentDiscovery(): Promise<Types.AgentProfile[]> {
  return invoke('refresh_agent_discovery');
}

export async function upsertAgentProfile(input: Types.UpsertAgentProfileInput): Promise<Types.AgentProfile> {
  return invoke('upsert_agent_profile', { input });
}

export async function probeAgentProfile(profileId: string): Promise<Types.AgentCapabilities> {
  return invoke('probe_agent_profile', { profileId });
}

export async function listWorkspaces(): Promise<Types.Workspace[]> {
  return invoke('list_workspaces');
}

export async function openWorkspace(cwd: string): Promise<Types.Workspace> {
  return invoke('open_workspace', { cwd });
}

export async function archiveWorkspace(workspaceId: string): Promise<void> {
  return invoke('archive_workspace', { workspaceId });
}

export async function getOrCreateDefaultWorkspace(): Promise<Types.Workspace> {
  return invoke('get_or_create_default_workspace');
}

export async function pickWorkspaceDirectory(): Promise<Types.Workspace | null> {
  return invoke('pick_workspace_directory');
}

export async function listWorkspaceFiles(cwd: string, directoryPath?: string): Promise<Types.WorkspaceFileEntry[]> {
  return invoke('list_workspace_files', { cwd, directoryPath });
}

export async function getGitDiff(cwd: string): Promise<Types.GitDiffResult> {
  return invoke('git_diff', { cwd });
}

// Conversation / Task
export async function listConversations(workspaceId: string, filter?: Types.ConversationFilter): Promise<Types.Conversation[]> {
  return invoke('list_conversations', { workspaceId, filter });
}

export async function listDiscoveredSessions(workspaceId: string, agentProfileId: string, scope: string): Promise<Types.ExternalSession[]> {
  return invoke('list_discovered_sessions', { workspaceId, agentProfileId, scope });
}

export async function createConversation(input: Types.CreateConversationInput): Promise<Types.ConversationState> {
  return invoke('create_conversation', { input });
}

export async function previewSessionConfig(
  input: Types.PreviewSessionConfigInput,
): Promise<Types.PreviewSessionConfigResult> {
  return invoke('preview_session_config', { input });
}

export async function importConversation(input: Types.ImportConversationInput): Promise<Types.ConversationState> {
  return invoke('import_conversation', { input });
}

export async function createTaskRun(input: Types.CreateTaskRunInput): Promise<Types.ConversationState> {
  return invoke('create_task_run', { input });
}

export async function listTaskRuns(workspaceId: string): Promise<Types.TaskRun[]> {
  return invoke('list_task_runs', { workspaceId });
}

export async function searchConversations(
  input: Types.SearchConversationsInput
): Promise<Types.Conversation[]> {
  return invoke('search_conversations', { input });
}

export async function getConversationState(conversationId: string): Promise<Types.ConversationState> {
  return invoke('get_conversation_state', { conversationId });
}

export async function getConversationTimeline(conversationId: string): Promise<Types.TimelineResponse> {
  return invoke('get_conversation_timeline', { conversationId });
}

// Messaging / Runtime Control
export async function sendUserMessage(input: Types.SendUserMessageInput): Promise<Types.TimelineResponse> {
  return invoke('send_user_message', { input });
}

export async function cancelTurn(conversationId: string): Promise<void> {
  return invoke('cancel_turn', { conversationId });
}

export async function deleteConversation(conversationId: string): Promise<void> {
  return invoke('delete_conversation', { conversationId });
}

export async function setSessionConfig(input: Types.SessionConfigInput): Promise<Types.SessionConfigOption[]> {
  return invoke('set_session_config', { input });
}

export async function setModel(input: Types.SetModelInput): Promise<Types.AcpSessionModels> {
  return invoke('set_model', { input });
}

export async function setMode(input: Types.SetModeInput): Promise<Types.AcpSessionModeState> {
  return invoke('set_mode', { input });
}

export async function persistAttachmentBlob(input: Types.PersistAttachmentBlobInput): Promise<Types.PersistAttachmentBlobOutput> {
  return invoke('persist_attachment_blob', { input });
}

// Permission / MCP / Skills
export async function listPermissions(conversationId: string): Promise<Types.PermissionDecision[]> {
  return invoke('list_permissions', { conversationId });
}

export async function resolvePermissionRequest(input: Types.ResolvePermissionInput): Promise<Types.PermissionDecision> {
  return invoke('resolve_permission_request', { input });
}

export async function listWorkspaceMcp(workspaceId: string): Promise<Types.McpServerConfig[]> {
  return invoke('list_workspace_mcp', { workspaceId });
}

export async function upsertWorkspaceMcp(config: Types.McpServerConfig): Promise<Types.McpServerConfig> {
  return invoke('upsert_workspace_mcp', { config });
}

export async function deleteWorkspaceMcp(configId: string): Promise<void> {
  return invoke('delete_workspace_mcp', { configId });
}

export async function listWorkspaceSkills(workspaceId: string): Promise<Types.SkillRecord[]> {
  return invoke('list_workspace_skills', { workspaceId });
}

// Terminal Commands
export async function spawnTerminal(id: string, cwd?: string | null): Promise<void> {
  return invoke('spawn_terminal', { id, cwd });
}

export async function writeToTerminal(id: string, data: string): Promise<void> {
  return invoke('write_to_terminal', { id, data });
}

export async function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  return invoke('resize_terminal', { id, cols, rows });
}

export async function closeTerminal(id: string): Promise<void> {
  return invoke('close_terminal', { id });
}

// IM Commands
export async function listImPlugins(): Promise<Types.ImPluginInfo[]> {
  return invoke('list_im_plugins');
}

export async function startImPlugin(platform: string, sidecarPath: string, credentialsJson: string, workspaceId?: string, agentProfileId?: string, modelId?: string): Promise<void> {
  return invoke('start_im_plugin', { platform, sidecarPath, credentialsJson, workspaceId, agentProfileId, modelId });
}

export async function updateImPluginConfig(platform: string, workspaceId?: string, agentProfileId?: string, modelId?: string): Promise<void> {
  return invoke('update_im_plugin_config', { platform, workspaceId, agentProfileId, modelId });
}

export async function stopImPlugin(platform: string): Promise<void> {
  return invoke('stop_im_plugin', { platform });
}

export async function approveImPairing(code: string): Promise<string> {
  return invoke('approve_im_pairing', { code });
}

export async function startWeixinLogin(sidecarPath: string): Promise<void> {
  return invoke('start_weixin_login', { sidecarPath });
}

export async function stopWeixinLogin(): Promise<void> {
  return invoke('stop_weixin_login');
}

// WebUI Settings
export async function getWebuiEnabled(): Promise<boolean> {
  return invoke('get_webui_enabled');
}

export async function setWebuiEnabled(enabled: boolean): Promise<string | null> {
  return invoke('set_webui_enabled', { enabled });
}

export async function getWebuiPassword(): Promise<string | null> {
  return invoke('get_webui_password');
}

export async function getWebuiInfo(): Promise<{ port: number; urls: string[] } | null> {
  return invoke('get_webui_info');
}


