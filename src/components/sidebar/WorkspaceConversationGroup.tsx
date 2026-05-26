import { useState, useEffect } from 'react';
import { Folder, FolderOpen, SquarePen, MoreVertical, Archive } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
  showAgentIcon?: boolean;
  onToggleExpand: (workspaceId: string) => void;
  onStartWorkspaceChat: (workspace: Types.Workspace) => void;
  onSelectConversation: (conversationId: string) => void;
  onToggleDeleteConversation: (conversationId: string) => void;
  onCancelDeleteConversation: (conversationId: string) => void;
  onArchiveWorkspace: (workspaceId: string) => void;
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
  showAgentIcon = true,
  onToggleExpand,
  onStartWorkspaceChat,
  onSelectConversation,
  onToggleDeleteConversation,
  onCancelDeleteConversation,
  onArchiveWorkspace,
}: WorkspaceConversationGroupProps) {
  const { t } = useTranslation("sidebar");
  const hasConversations = conversations.length > 0;
  const [showMenu, setShowMenu] = useState(false);
  const [visibleCount, setVisibleCount] = useState(10);

  // If the active conversation is not within the first visibleCount items,
  // expand visibleCount to make it visible.
  useEffect(() => {
    if (activeConversationId) {
      const activeIndex = conversations.findIndex((c) => c.id === activeConversationId);
      if (activeIndex !== -1) {
        setVisibleCount((prev) => {
          if (activeIndex >= prev) {
            return Math.ceil((activeIndex + 1) / 10) * 10;
          }
          return prev;
        });
      }
    }
  }, [activeConversationId, conversations]);

  return (
    <div className="space-y-0.5">
      <div className="group relative w-full">
        <button
          type="button"
          onClick={() => onToggleExpand(workspace.id)}
          className="md:min-h-0 min-h-[44px] w-full text-left px-3 py-2 pr-20 rounded-container flex items-center gap-2.5 transition-colors min-w-0 text-near-black hover:bg-light-gray/50"
        >
          {isExpanded ? (
            <FolderOpen className="w-3.5 h-3.5 shrink-0 text-stone" />
          ) : (
            <Folder className="w-3.5 h-3.5 shrink-0 text-stone" />
          )}
          <span className="text-caption truncate flex-1 min-w-0">{getWorkspaceLabel(workspace)}</span>
        </button>
        {/* Action buttons on the right */}
        <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onStartWorkspaceChat(workspace);
            }}
            className="md:min-h-0 min-h-[44px] rounded-container p-2 text-stone opacity-0 transition-all hover:bg-light-gray/60 hover:text-pure-black focus:opacity-100 focus-visible:opacity-100 group-hover:opacity-100 flex items-center justify-center"
            title={`New chat in ${getWorkspaceLabel(workspace)}`}
            aria-label={`New chat in ${getWorkspaceLabel(workspace)}`}
          >
            <SquarePen className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setShowMenu(!showMenu);
            }}
            className="md:min-h-0 min-h-[44px] rounded-container p-2 text-stone opacity-0 transition-all hover:bg-light-gray/60 hover:text-pure-black focus:opacity-100 focus-visible:opacity-100 group-hover:opacity-100 flex items-center justify-center"
            title="More actions"
            aria-label="More actions"
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Dropdown menu */}
        {showMenu && (
          <>
            {/* Backdrop to close menu */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => setShowMenu(false)}
            />
            {/* Menu content */}
            <div
              className="absolute right-0 top-full mt-1 z-50 bg-pure-white border border-light-gray rounded-container shadow-lg min-w-[140px]"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => {
                  onArchiveWorkspace(workspace.id);
                  setShowMenu(false);
                }}
                className="w-full text-left px-3 py-2 flex items-center gap-2.5 text-small text-near-black hover:bg-light-gray/60 transition-colors rounded-container"
              >
                <Archive className="w-3.5 h-3.5 shrink-0 text-stone" />
                <span>Archive</span>
              </button>
            </div>
          </>
        )}
      </div>

      {isExpanded && (
        <div className="ml-5 pl-2 border-l border-light-gray/50 space-y-0.5 mt-0.5">
          {hasConversations ? (
            <>
              {conversations.slice(0, visibleCount).map((conversation) => {
                const agent = agentProfiles.find((a) => a.id === conversation.agent_profile_id);
                return (
                  <SidebarItem
                    key={conversation.id}
                    title={conversation.title || 'Untitled Chat'}
                    agentCommand={agent?.command ?? conversation.agent_profile_id}
                    status={conversation.status}
                    imSource={conversation.source && conversation.source !== 'oneagent' ? conversation.source : undefined}
                    renderAgentLogo={renderAgentLogo}
                    showAgentIcon={showAgentIcon}
                    unread={unreadCompletedConversations.has(conversation.id)}
                    active={activeConversationId === conversation.id}
                    onClick={() => onSelectConversation(conversation.id)}
                    deletePending={pendingDeleteConversationId === conversation.id}
                    onDelete={() => onToggleDeleteConversation(conversation.id)}
                    onCancelDelete={() => onCancelDeleteConversation(conversation.id)}
                  />
                );
              })}
              {conversations.length > visibleCount && (
                <button
                  type="button"
                  onClick={() => setVisibleCount((prev) => prev + 10)}
                  className="w-full text-left px-9 py-2 text-small text-stone hover:text-near-black hover:bg-light-gray/40 rounded-container transition-colors md:min-h-0 min-h-[44px]"
                >
                  {t("showMore")}
                </button>
              )}
            </>
          ) : (
            <div className="px-3 py-1 text-[11px] text-silver">{t("noConversations")}</div>
          )}
        </div>
      )}
    </div>
  );
}