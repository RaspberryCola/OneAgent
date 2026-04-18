import type * as Types from '../backend/types';

export function buildConversationTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Untitled Chat';
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 60).trimEnd()}...`;
}

export function isConversationActive(state: Types.ConversationState | null): boolean {
  if (!state) return false;
  return state.runtime.session_phase === 'loading'
    || state.runtime.turn_phase === 'running'
    || state.runtime.turn_phase === 'cancelling'
    || state.runtime.turn_phase === 'failed';
}

export function findConversationAcrossWorkspaces(
  workspaceConversations: Map<string, Types.Conversation[]>,
  conversationId: string,
): { workspaceId: string; conversation: Types.Conversation } | null {
  for (const [workspaceId, conversations] of workspaceConversations.entries()) {
    const conversation = conversations.find((item) => item.id === conversationId);
    if (conversation) {
      return { workspaceId, conversation };
    }
  }
  return null;
}
