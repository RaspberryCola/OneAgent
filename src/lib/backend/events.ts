import { listen } from './transport';
import type { UnlistenFn } from './transport';
import type { AvailableCommand, MessageProjection, ToolCallProjection, PermissionDecision, ConversationState, SessionConfigOption, AcpSessionModels, AcpSessionModeState, AgentCapabilities, PendingPermissionRequest, TerminalRecord, TaskRun } from './types';

// The backend now emits normalized envelopes, replacing the older raw-payload assumptions.

export type AgentProfileProbedPayload = { profile_id: string; capabilities: AgentCapabilities };
export type ConversationStateChangedPayload = { conversation_id: string; state: ConversationState };
export type ConversationMessageAppendedPayload = { conversation_id: string; message: MessageProjection };
export type ConversationMessageUpdatedPayload = { conversation_id: string; message: MessageProjection };
export type ConversationTurnFinishedPayload = { conversation_id: string; turn_id: string; status: string };
export type ConversationPermissionRequestedPayload = { conversation_id: string; request: PendingPermissionRequest };
export type ConversationPermissionResolvedPayload = { conversation_id: string; decision: PermissionDecision };
export type ConversationToolCallChangedPayload = { conversation_id: string; tool_call: ToolCallProjection };
export type ConversationTerminalOutputPayload = {
  conversation_id: string;
  terminal_id: string;
  event: string;
  stream?: boolean;
  content?: string;
  terminal?: TerminalRecord;
};
export type TaskRunStateChangedPayload = { conversation_id: string; task_run: TaskRun };
export type ConversationDeletedPayload = { conversation_id: string };
export type ConversationConfigUpdatedPayload = {
  conversation_id: string;
  config_options?: SessionConfigOption[];
  models?: AcpSessionModels;
  modes?: AcpSessionModeState;
};
export type ConversationCommandsUpdatedPayload = {
  conversation_id: string;
  available_commands: AvailableCommand[];
};

export type ImPairingRequestedPayload = {
  code: string;
  platform_user_id: string;
  platform_type: string;
  display_name: string;
};

export type ImWeixinLoginQrPayload = {
  qr_url: string;
};

export type ImWeixinLoginDonePayload = {
  account_id: string;
  bot_token: string;
};

export type ImUserAuthorizedPayload = {
  platform_user_id: string;
  platform_type: string;
};

export function onAgentProfileProbed(handler: (payload: AgentProfileProbedPayload) => void): Promise<UnlistenFn> {
  return listen<AgentProfileProbedPayload>('agent:profile_probed', (event) => handler(event.payload));
}

export function onConversationConfigUpdated(handler: (payload: ConversationConfigUpdatedPayload) => void): Promise<UnlistenFn> {
  return listen<ConversationConfigUpdatedPayload>('conversation:config_updated', (event) => handler(event.payload));
}

export function onConversationStateChanged(handler: (payload: ConversationStateChangedPayload) => void): Promise<UnlistenFn> {
  return listen<ConversationStateChangedPayload>('conversation:state_changed', (event) => handler(event.payload));
}

export function onConversationMessageAppended(handler: (payload: ConversationMessageAppendedPayload) => void): Promise<UnlistenFn> {
  return listen<ConversationMessageAppendedPayload>('conversation:message_appended', (event) => handler(event.payload));
}

export function onConversationMessageUpdated(handler: (payload: ConversationMessageUpdatedPayload) => void): Promise<UnlistenFn> {
  return listen<ConversationMessageUpdatedPayload>('conversation:message_updated', (event) => handler(event.payload));
}

export function onConversationTurnFinished(handler: (payload: ConversationTurnFinishedPayload) => void): Promise<UnlistenFn> {
  return listen<ConversationTurnFinishedPayload>('conversation:turn_finished', (event) => handler(event.payload));
}

export function onConversationPermissionRequested(handler: (payload: ConversationPermissionRequestedPayload) => void): Promise<UnlistenFn> {
  return listen<ConversationPermissionRequestedPayload>('conversation:permission_requested', (event) => handler(event.payload));
}

export function onConversationPermissionResolved(handler: (payload: ConversationPermissionResolvedPayload) => void): Promise<UnlistenFn> {
  return listen<ConversationPermissionResolvedPayload>('conversation:permission_resolved', (event) => handler(event.payload));
}

export function onConversationToolCallChanged(handler: (payload: ConversationToolCallChangedPayload) => void): Promise<UnlistenFn> {
  return listen<ConversationToolCallChangedPayload>('conversation:tool_call_changed', (event) => handler(event.payload));
}

export function onConversationTerminalOutput(handler: (payload: ConversationTerminalOutputPayload) => void): Promise<UnlistenFn> {
  return listen<ConversationTerminalOutputPayload>('conversation:terminal_output', (event) => handler(event.payload));
}

export function onTaskRunStateChanged(handler: (payload: TaskRunStateChangedPayload) => void): Promise<UnlistenFn> {
  return listen<TaskRunStateChangedPayload>('task_run:state_changed', (event) => handler(event.payload));
}

export function onConversationDeleted(handler: (payload: ConversationDeletedPayload) => void): Promise<UnlistenFn> {
  return listen<ConversationDeletedPayload>('conversation:deleted', (event) => handler(event.payload));
}

export function onConversationCommandsUpdated(handler: (payload: ConversationCommandsUpdatedPayload) => void): Promise<UnlistenFn> {
  return listen<ConversationCommandsUpdatedPayload>('conversation:commands_updated', (event) => handler(event.payload));
}

export function onImPairingRequested(handler: (payload: ImPairingRequestedPayload) => void): Promise<UnlistenFn> {
  return listen<ImPairingRequestedPayload>('im:pairing_requested', (event) => handler(event.payload));
}

export function onImWeixinLoginQr(handler: (payload: ImWeixinLoginQrPayload) => void): Promise<UnlistenFn> {
  return listen<ImWeixinLoginQrPayload>('im:weixin_login_qr', (event) => handler(event.payload));
}

export function onImWeixinLoginScanned(handler: () => void): Promise<UnlistenFn> {
  return listen<Record<string, never>>('im:weixin_login_scanned', () => handler());
}

export function onImWeixinLoginDone(handler: (payload: ImWeixinLoginDonePayload) => void): Promise<UnlistenFn> {
  return listen<ImWeixinLoginDonePayload>('im:weixin_login_done', (event) => handler(event.payload));
}

export function onImUserAuthorized(handler: (payload: ImUserAuthorizedPayload) => void): Promise<UnlistenFn> {
  return listen<ImUserAuthorizedPayload>('im:user_authorized', (event) => handler(event.payload));
}

export type ImPluginConfigChangedPayload = {
  platform: string;
  workspace_id?: string | null;
  agent_profile_id?: string | null;
};

export function onImPluginConfigChanged(handler: (payload: ImPluginConfigChangedPayload) => void): Promise<UnlistenFn> {
  return listen<ImPluginConfigChangedPayload>('im:plugin_config_changed', (event) => handler(event.payload));
}
