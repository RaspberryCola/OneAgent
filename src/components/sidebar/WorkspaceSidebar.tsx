import { PanelLeftClose, Plus, Search, Settings, LogOut } from 'lucide-react';
import type * as Types from '../../lib/backend/types';
import { WorkspaceConversationGroup } from './WorkspaceConversationGroup';

interface WorkspaceSidebarProps {
  isMobileSidebarOpen: boolean;
  isDesktopSidebarOpen: boolean;
  workspaces: Types.Workspace[];
  workspaceConversations: Map<string, Types.Conversation[]>;
  expandedWorkspaces: Set<string>;
  activeConversationId: string | null;
  unreadCompletedConversations: Set<string>;
  pendingDeleteConversationId: string | null;
  agentProfiles: Types.AgentProfile[];
  getWorkspaceLabel: (workspace: Types.Workspace | null | undefined) => string;
  renderAgentLogo: (agentCommand: string, className: string) => React.ReactNode;
  onCloseMobileSidebar: () => void;
  onCloseDesktopSidebar: () => void;
  onNewChat: () => void;
  onOpenSearch: () => void;
  onOpenWorkspacePicker: () => void;
  onToggleWorkspaceExpand: (workspaceId: string) => void;
  onStartWorkspaceChat: (workspace: Types.Workspace) => void;
  onSelectConversation: (conversationId: string) => void;
  onToggleDeleteConversation: (conversationId: string) => void;
  onCancelDeleteConversation: (conversationId: string) => void;
  onOpenSettings: () => void;
  onLogout?: () => void;
}

export function WorkspaceSidebar({
  isMobileSidebarOpen,
  isDesktopSidebarOpen,
  workspaces,
  workspaceConversations,
  expandedWorkspaces,
  activeConversationId,
  unreadCompletedConversations,
  pendingDeleteConversationId,
  agentProfiles,
  getWorkspaceLabel,
  renderAgentLogo,
  onCloseMobileSidebar,
  onCloseDesktopSidebar,
  onNewChat,
  onOpenSearch,
  onOpenWorkspacePicker,
  onToggleWorkspaceExpand,
  onStartWorkspaceChat,
  onSelectConversation,
  onToggleDeleteConversation,
  onCancelDeleteConversation,
  onOpenSettings,
  onLogout,
}: WorkspaceSidebarProps) {
  return (
    <>
      {isMobileSidebarOpen && (
        <div className="fixed inset-0 bg-pure-black/20 z-20 md:hidden transition-opacity" onClick={onCloseMobileSidebar} />
      )}

      <aside
        className={`
          fixed md:relative inset-y-0 left-0 z-30
          bg-snow shrink-0 flex flex-col transition-all duration-300 ease-in-out
          ${isMobileSidebarOpen ? 'translate-x-0 w-[260px] border-r border-light-gray' : '-translate-x-full md:translate-x-0'}
          ${isDesktopSidebarOpen ? 'md:w-[260px]' : 'md:w-0 md:overflow-hidden'}
        `}
      >
        <div className="w-[260px] h-full flex flex-col">
          <div className="p-3 shrink-0">
            <div className="flex items-center justify-between mb-3 px-2">
              <div className="flex items-center justify-start h-8">
                <img src="/oneagent_horizontal.svg" alt=">_One Logo" className="h-[22px] object-contain" />
              </div>
              <button
                onClick={onCloseDesktopSidebar}
                className="hidden md:flex p-1 text-stone hover:text-pure-black rounded-interactive hover:bg-light-gray/50 transition-colors"
                title="Close Sidebar"
              >
                <PanelLeftClose className="w-[18px] h-[18px]" />
              </button>
              <button
                onClick={onCloseMobileSidebar}
                className="md:hidden p-1 text-stone hover:text-pure-black rounded-interactive hover:bg-light-gray/50 transition-colors"
              >
                <PanelLeftClose className="w-[18px] h-[18px]" />
              </button>
            </div>

            <div className="space-y-0.5">
              <button
                onClick={onNewChat}
                className={`w-full text-left px-3 py-1.5 rounded-container flex items-center gap-2.5 transition-colors min-w-0 ${
                  activeConversationId === null ? 'text-pure-black font-medium bg-light-gray' : 'text-near-black hover:bg-light-gray/60'
                }`}
              >
                <Plus className="w-3.5 h-3.5 shrink-0" />
                <span className="text-caption truncate w-full block">New Chat</span>
              </button>
              <button
                onClick={onOpenSearch}
                className="w-full text-left px-3 py-1.5 rounded-container flex items-center gap-2.5 transition-colors min-w-0 text-near-black hover:bg-light-gray/60"
              >
                <Search className="w-3.5 h-3.5 shrink-0" />
                <span className="text-caption truncate w-full block">Search</span>
              </button>
            </div>
          </div>

          <div className="px-3 shrink-0">
            <div className="px-3 mb-0.5 mt-2 flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium text-stone uppercase tracking-widest opacity-80">
                Workspaces
              </span>
              <button
                type="button"
                onClick={onOpenWorkspacePicker}
                className="rounded-container p-1.5 text-stone transition-colors hover:bg-light-gray/60 hover:text-pure-black"
                title="Open workspace"
                aria-label="Open workspace"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 pb-4 no-scrollbar">
            <div className="space-y-1">
              {workspaces.length === 0 && <div className="px-2 py-1 text-[13px] text-silver">No workspaces</div>}
              {workspaces.map((workspace) => (
                <WorkspaceConversationGroup
                  key={workspace.id}
                  workspace={workspace}
                  isExpanded={expandedWorkspaces.has(workspace.id)}
                  conversations={workspaceConversations.get(workspace.id) ?? []}
                  activeConversationId={activeConversationId}
                  unreadCompletedConversations={unreadCompletedConversations}
                  pendingDeleteConversationId={pendingDeleteConversationId}
                  agentProfiles={agentProfiles}
                  getWorkspaceLabel={getWorkspaceLabel}
                  renderAgentLogo={renderAgentLogo}
                  onToggleExpand={onToggleWorkspaceExpand}
                  onStartWorkspaceChat={onStartWorkspaceChat}
                  onSelectConversation={onSelectConversation}
                  onToggleDeleteConversation={onToggleDeleteConversation}
                  onCancelDeleteConversation={onCancelDeleteConversation}
                />
              ))}
            </div>
          </div>

          <div className="p-3 shrink-0 space-y-1">
            <button
              onClick={onOpenSettings}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-small rounded-container hover:bg-light-gray/60 transition-colors text-near-black text-left"
            >
              <Settings className="w-3.5 h-3.5 shrink-0" />
              Settings
            </button>
            {onLogout && (
              <button
                onClick={onLogout}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-small rounded-container hover:bg-light-gray/60 hover:text-rose-600 transition-colors text-near-black text-left"
              >
                <LogOut className="w-3.5 h-3.5 shrink-0" />
                Sign Out
              </button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
