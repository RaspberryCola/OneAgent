import { Folder, FolderOpen, SquarePen } from 'lucide-react';
import type * as Types from '../../lib/backend/types';
import { SidebarItem } from './SidebarItem';

interface WorkspaceConversationGroupProps {
  workspace: Types.Workspace;
  isExpanded: boolean;
  conversations: Types.Conversation[];
  activeConversationId: string | null;
  unreadCompletedConversations: Set<string>;
  pendingDeleteConversationId: string | null;
  agentProfiles: Types.AgentProfile[];
  getWorkspaceLabel: (workspace: Types.Workspace | null | undefined) => string;
  renderAgentLogo: (agentCommand: string, className: string) => React.ReactNode;
  onToggleExpand: (workspaceId: string) => void;
  onStartWorkspaceChat: (workspace: Types.Workspace) => void;
  onSelectConversation: (conversationId: string) => void;
  onToggleDeleteConversation: (conversationId: string) => void;
  onCancelDeleteConversation: (conversationId: string) => void;
}

export function WorkspaceConversationGroup({
  workspace,
  isExpanded,
  conversations,
  activeConversationId,
  unreadCompletedConversations,
  pendingDeleteConversationId,
  agentProfiles,
  getWorkspaceLabel,
  renderAgentLogo,
  onToggleExpand,
  onStartWorkspaceChat,
  onSelectConversation,
  onToggleDeleteConversation,
  onCancelDeleteConversation,
}: WorkspaceConversationGroupProps) {
  const hasConversations = conversations.length > 0;

  return (
    <div className="space-y-0.5">
      <div className="group relative w-full">
        <button
          type="button"
          onClick={() => onToggleExpand(workspace.id)}
          className="w-full text-left px-3 py-1 pr-10 rounded-container flex items-center gap-2.5 transition-colors min-w-0 text-near-black hover:bg-light-gray/50"
        >
          {isExpanded ? (
            <FolderOpen className="w-3.5 h-3.5 shrink-0 text-stone" />
          ) : (
            <Folder className="w-3.5 h-3.5 shrink-0 text-stone" />
          )}
          <span className="text-caption truncate flex-1 min-w-0">{getWorkspaceLabel(workspace)}</span>
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onStartWorkspaceChat(workspace);
          }}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-container p-1.5 text-stone opacity-0 transition-all hover:bg-light-gray/60 hover:text-pure-black focus:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
          title={`New chat in ${getWorkspaceLabel(workspace)}`}
          aria-label={`New chat in ${getWorkspaceLabel(workspace)}`}
        >
          <SquarePen className="h-3.5 w-3.5" />
        </button>
      </div>

      {isExpanded && (
        <div className="ml-5 pl-2 border-l border-light-gray/50 space-y-0.5 mt-0.5">
          {hasConversations ? (
            conversations.map((conversation) => {
              const agent = agentProfiles.find((a) => a.id === conversation.agent_profile_id);
              return (
                <SidebarItem
                  key={conversation.id}
                  title={conversation.title || 'Untitled Chat'}
                  agentCommand={agent?.command ?? conversation.agent_profile_id}
                  status={conversation.status}
                  renderAgentLogo={renderAgentLogo}
                  unread={unreadCompletedConversations.has(conversation.id)}
                  active={activeConversationId === conversation.id}
                  onClick={() => onSelectConversation(conversation.id)}
                  deletePending={pendingDeleteConversationId === conversation.id}
                  onDelete={() => onToggleDeleteConversation(conversation.id)}
                  onCancelDelete={() => onCancelDeleteConversation(conversation.id)}
                />
              );
            })
          ) : (
            <div className="px-3 py-1 text-[11px] text-silver">No conversations</div>
          )}
        </div>
      )}
    </div>
  );
}
