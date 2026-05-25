// Agent Discovery Types
export interface AgentDiscoveryStatus {
  name: string;
  command: string;
  installed: boolean;
  source: 'native' | 'bridge';
  availability: 'ready' | 'degraded' | 'unavailable';
  detail?: string | null;
  profile_id?: string | null;
}

// Core Entity Types

// Backend Error Types
export type ErrorCode =
  | 'empty_message'
  | 'empty_command'
  | 'invalid_workspace_path'
  | 'invalid_input'
  | 'active_turn_running'
  | 'conversation_not_ready'
  | 'missing_binding'
  | 'workspace_not_found'
  | 'agent_profile_not_found'
  | 'conversation_not_found'
  | 'pending_permission_not_found'
  | 'permission_not_pending'
  | 'permission_fingerprint_mismatch'
  | 'adapter_error'
  | 'runtime_not_found'
  | 'adapter_not_found'
  | 'adapter_spawn_failed'
  | 'claude_auth_required'
  | 'acp_initialize_failed'
  | 'runtime_error'
  | 'storage_error'
  | 'unknown';

export interface BackendError {
  code: ErrorCode;
  message: string;
  details?: any;
}

export interface Workspace {
  id: string;
  cwd: string;
  display_name: string;
  trusted: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size_bytes?: number | null;
  modified_at?: string | null;
}

export interface GitDiffResult {
  unstaged: string;
  staged: string;
}

export interface FileContentResult {
  content: string;
  size_bytes: number;
}

export interface AgentProfile {
  id: string;
  kind: 'acp' | 'compat';
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  launch_mode: 'native' | 'npm_adapter';
  runtime_preference?: 'bundled_bun' | 'system_bun' | 'system_node' | null;
  package_name?: string | null;
  package_version?: string | null;
  display_source: 'native' | 'bridge';
  capabilities_cache: AgentCapabilities | null;
  enabled: boolean;
}

export interface AgentPromptCapabilities {
  text: boolean;
  resource_link: boolean;
  embedded_context: boolean;
  image: boolean;
  audio: boolean;
}

export interface AgentSessionCapabilities {
  load: boolean;
  list: boolean;
}

export interface SessionConfigOption {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  option_type: string;
  current_value: any;
  options: any;
  raw: any;
}

export interface AvailableCommand {
  name: string;
  description: string;
  input_hint?: string | null;
}

// ACP Models types (unstable API)
export interface AcpAvailableModel {
  id?: string;
  model_id?: string;  // OpenCode uses modelId instead of id
  name?: string;
  raw?: any;
}

export interface AcpSessionModels {
  current_model_id?: string;
  available_models?: AcpAvailableModel[];
}

export interface AcpSessionMode {
  id: string;
  name: string;
  description?: string | null;
}

export interface AcpSessionModeState {
  current_mode_id: string;
  available_modes: AcpSessionMode[];
}

export interface AgentCapabilities {
  protocol_version: string;
  agent_info: any;
  prompt_capabilities: AgentPromptCapabilities;
  session_capabilities: AgentSessionCapabilities;
  raw: any;
}

export interface ConversationRuntimeState {
  connection_phase: 'disconnected' | 'initializing' | 'ready';
  session_phase: 'cold' | 'loading' | 'hot';
  turn_phase: 'idle' | 'running' | 'cancelling' | 'failed';
  last_error?: string | null;
  last_transition_at: string;
}

export interface Conversation {
  id: string;
  workspace_id: string;
  agent_profile_id: string;
  origin: 'oneagent_managed' | 'agent_discovered' | 'imported' | 'worker_task';
  status: 'sleep' | 'initializing' | 'recovering' | 'connected' | 'running' | 'cancelling' | 'cancelled' | 'failed' | 'completed' | 'closed' | 'idle' | 'starting' | 'ready';
  title: string;
  created_at: string;
  updated_at: string;
  last_event_seq: number;
  source?: string;
  channel_chat_id?: string | null;
}

export interface AgentSessionBinding {
  id: string;
  conversation_id: string;
  adapter_kind: 'acp' | 'compat';
  remote_session_id: string;
  cwd: string;
  load_supported: boolean;
  source: 'discovered' | 'new' | 'imported';
  last_synced_at: string;
}

export interface ConversationState {
  conversation: Conversation;
  runtime: ConversationRuntimeState;
  binding?: AgentSessionBinding | null;
  task_run?: TaskRun | null;
  config_options: SessionConfigOption[];
  models?: AcpSessionModels | null;
  modes?: AcpSessionModeState | null;
  available_commands: AvailableCommand[];
  pending_permissions: PendingPermissionRequest[];
}

export interface TaskRun {
  id: string;
  conversation_id: string;
  workspace_id: string;
  agent_profile_id: string;
  goal: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  result_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageProjection {
  id: string;
  conversation_id: string;
  turn_id: string;
  role: 'user' | 'agent' | 'system' | 'tool';
  kind: 'text' | 'thinking' | 'status' | 'plan' | 'terminal' | 'error' | 'diff' | 'resource';
  content_json: any;
  created_at: string;
}

export interface ToolCallProjection {
  id: string;
  conversation_id: string;
  turn_id: string;
  tool_call_id: string;
  title: string;
  kind: string;
  status: string;
  raw_input_json: any;
  raw_output_json: any;
  content_json: any;
  diffs_json: any;
  terminal_ids_json: any;
  locations_json: any;
  started_at: string;
  ended_at: string;
}

export interface PendingPermissionRequest {
  id: string;
  conversation_id: string;
  turn_id: string;
  tool_call_id: string;
  fingerprint: string;
  options_json: any;
  status: 'pending' | 'resolved' | 'cancelled' | 'expired';
  created_at: string;
  resolved_at?: string | null;
}

export interface PermissionDecision {
  id: string;
  conversation_id: string;
  tool_call_id: string;
  scope: string;
  fingerprint: string;
  decision: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | 'cancelled';
  created_at: string;
}

export interface TerminalRecord {
  id: string;
  terminal_id: string;
  conversation_id: string;
  turn_id: string;
  cwd: string;
  command: string;
  args_json: any;
  status: string;
  stdout_buffer: string;
  stderr_buffer: string;
  started_at: string;
  ended_at?: string | null;
}

export interface RuntimeEvent {
  seq: number;
  conversation_id: string;
  event_type: string;
  payload_json: any;
  created_at: string;
}

export interface TimelineResponse {
  events: RuntimeEvent[];
  messages: MessageProjection[];
  tool_calls: ToolCallProjection[];
  pending_permissions: PendingPermissionRequest[];
  terminals: TerminalRecord[];
}

export interface WorkspaceBootstrap {
  workspace: Workspace;
  agent_profiles: AgentProfile[];
  conversations: Conversation[];
  discovered_sessions: ExternalSession[];
  mcp: McpServerConfig[];
  skills: SkillRecord[];
}

export interface ExternalSession {
  remote_session_id: string;
  title: string;
  cwd?: string;
  updated_at?: string;
  // Other fields as defined by the protocol
}

export interface McpServerConfig {
  id: string;
  workspace_id: string;
  name: string;
  command: string;
  args_json: any;
  env_json: any;
  enabled: boolean;
}

export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface McpToolInfo {
  name: string;
  description?: string | null;
  input_schema?: any;
}

export interface McpServerStatus {
  config_id: string;
  name: string;
  status: McpConnectionStatus;
  tools: McpToolInfo[];
  error_message?: string | null;
  last_updated: string;
}

export interface SkillRecord {
  id: string;
  scope: 'project' | 'user' | 'agent_specific';
  name: string;
  description: string;
  location: string;
  source_dir: string;
  owner: string;
  enabled: boolean;
  diagnostics_json: any;
}

export interface BackendError {
  code: 
    | 'empty_message' | 'empty_command' | 'invalid_workspace_path' | 'invalid_input'
    | 'active_turn_running' | 'conversation_not_ready' | 'missing_binding'
    | 'workspace_not_found' | 'agent_profile_not_found' | 'conversation_not_found' | 'pending_permission_not_found'
    | 'permission_not_pending' | 'permission_fingerprint_mismatch'
    | 'adapter_error' | 'runtime_not_found' | 'adapter_not_found' | 'adapter_spawn_failed'
    | 'claude_auth_required' | 'acp_initialize_failed' | 'runtime_error' | 'storage_error' | 'unknown';
  message: string;
  details?: any;
}

// Input Types

export interface BootstrapWorkspaceInput {
  workspace_id: string;
  agent_profile_id?: string;
  discovered_scope?: string;
}

export interface UpsertAgentProfileInput {
  id?: string;
  kind: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  launch_mode: 'native' | 'npm_adapter';
  runtime_preference?: 'bundled_bun' | 'system_bun' | 'system_node' | null;
  package_name?: string | null;
  package_version?: string | null;
  display_source: 'native' | 'bridge';
  enabled: boolean;
}

export interface ConversationFilter {
  include_tasks: boolean;
}

export interface CreateConversationInput {
  workspace_id: string;
  agent_profile_id: string;
  title?: string;
}

export interface PreviewSessionConfigInput {
  workspace_id: string;
  agent_profile_id: string;
}

export interface PreviewSessionConfigResult {
  config_options: SessionConfigOption[];
  models?: AcpSessionModels | null;
  modes?: AcpSessionModeState | null;
}

export interface ImportConversationInput {
  workspace_id: string;
  agent_profile_id: string;
  remote_session_id: string;
}

export interface CreateTaskRunInput {
  workspace_id: string;
  agent_profile_id: string;
  goal: string;
  title?: string;
}

export interface AttachmentInput {
  id: string;
  name: string;
  path: string;
  mime_type?: string | null;
  kind: 'image' | 'audio' | 'file';
  usage_intent: 'auto' | 'vision_input' | 'file_resource';
  delivery_preference: 'auto' | 'resource_link' | 'embedded';
}

export interface SendUserMessageInput {
  conversation_id: string;
  text: string;
  attachments?: AttachmentInput[];
}

export interface ResolvePermissionInput {
  conversation_id: string;
  tool_call_id: string;
  fingerprint: string;
  decision: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | 'cancelled';
}

export interface SessionConfigInput {
  conversation_id: string;
  config_id: string;
  value: any;
}

export interface SetModelInput {
  conversation_id: string;
  model_id: string;
}

export interface SetModeInput {
  conversation_id: string;
  mode_id: string;
}

export interface PersistAttachmentBlobInput {
  name: string;
  mime_type?: string | null;
  base64_data: string;
}

export interface PersistAttachmentBlobOutput {
  path: string;
}

// TaskRun list input (optional, workspace_id passed directly)
export interface ListTaskRunsInput {
  workspace_id: string;
}

// Search Conversations
export interface SearchConversationsInput {
  workspace_id: string;
  query: string;
  include_tasks?: boolean;
}

// IM Plugin Types
export interface ImPluginInfo {
  platform: string;
  enabled: boolean;
  status: string;
  workspace_id?: string | null;
  agent_profile_id?: string | null;
  model_id?: string | null;
}

