import { useState, useCallback, useRef, useEffect } from 'react';
import { PanelLeftClose, Plus, Search, Settings, LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type * as Types from '../../lib/backend/types';
import { WorkspaceConversationGroup } from './WorkspaceConversationGroup';
import { STORAGE_KEYS, SIDEBAR_CONFIG } from '../../lib/constants';

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
  onArchiveWorkspace: (workspaceId: string) => void;
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
  onArchiveWorkspace,
  onOpenSettings,
  onLogout,
}: WorkspaceSidebarProps) {
  const { t } = useTranslation("sidebar");

  // Sidebar width state with persistence
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEYS.SIDEBAR_WIDTH_CACHE);
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (parsed >= SIDEBAR_CONFIG.MIN_WIDTH && parsed <= SIDEBAR_CONFIG.MAX_WIDTH) {
        return parsed;
      }
    }
    return SIDEBAR_CONFIG.DEFAULT_WIDTH;
  });

  const [isDragging, setIsDragging] = useState(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // Cleanup drag event listeners on unmount
  useEffect(() => {
    return () => { dragCleanupRef.current?.(); };
  }, []);

  // Drag handler - dragging right increases width
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);

    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      const newWidth = Math.min(SIDEBAR_CONFIG.MAX_WIDTH, Math.max(SIDEBAR_CONFIG.MIN_WIDTH, startWidth + delta));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      setIsDragging(false);
      localStorage.setItem(STORAGE_KEYS.SIDEBAR_WIDTH_CACHE, String(sidebarWidth));
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      dragCleanupRef.current = null;
    };

    dragCleanupRef.current = onMouseUp;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth]);

  return (
    <>
      {isMobileSidebarOpen && (
        <div className="fixed inset-0 bg-pure-black/20 z-20 md:hidden transition-opacity" onClick={onCloseMobileSidebar} />
      )}

      <aside
        className={`
          fixed md:relative inset-y-0 left-0 z-30
          bg-snow shrink-0 flex flex-col
          ${isDragging ? '' : 'transition-all duration-300 ease-in-out'}
          ${isMobileSidebarOpen ? 'translate-x-0 border-r border-light-gray' : '-translate-x-full md:translate-x-0'}
          ${isDesktopSidebarOpen ? '' : 'md:w-0 md:overflow-hidden'}
        `}
        style={{ width: isDesktopSidebarOpen ? sidebarWidth : undefined }}
      >
        <div className="h-full flex flex-col" style={{ width: sidebarWidth }}>
          <div className="p-3 shrink-0">
            <div className="flex items-center justify-between mb-3 px-2">
              <div className="flex items-center justify-start h-8">
                <img src="/oneagent_horizontal.svg" alt=">_One Logo" className="h-[22px] object-contain" />
              </div>
              <button
                onClick={onCloseDesktopSidebar}
                className="hidden md:flex p-1 text-stone hover:text-pure-black rounded-interactive hover:bg-light-gray/50 transition-colors"
                title={t("closeSidebar")}
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
                <span className="text-caption truncate w-full block">{t("newChat")}</span>
              </button>
              <button
                onClick={onOpenSearch}
                className="w-full text-left px-3 py-1.5 rounded-container flex items-center gap-2.5 transition-colors min-w-0 text-near-black hover:bg-light-gray/60"
              >
                <Search className="w-3.5 h-3.5 shrink-0" />
                <span className="text-caption truncate w-full block">{t("search")}</span>
              </button>
            </div>
          </div>

          <div className="px-3 shrink-0">
            <div className="px-3 mb-0.5 mt-2 flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium text-stone uppercase tracking-widest opacity-80">
                {t("workspaces")}
              </span>
              <button
                type="button"
                onClick={onOpenWorkspacePicker}
                className="rounded-container p-1.5 text-stone transition-colors hover:bg-light-gray/60 hover:text-pure-black"
                title={t("openWorkspace")}
                aria-label={t("openWorkspace")}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 pb-4 no-scrollbar">
            <div className="space-y-1">
              {workspaces.length === 0 && <div className="px-2 py-1 text-[13px] text-silver">{t("noWorkspaces")}</div>}
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
                  onArchiveWorkspace={onArchiveWorkspace}
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
              {t("settings")}
            </button>
            {onLogout && (
              <button
                onClick={onLogout}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-small rounded-container hover:bg-light-gray/60 hover:text-rose-600 transition-colors text-near-black text-left"
              >
                <LogOut className="w-3.5 h-3.5 shrink-0" />
                {t("signOut")}
              </button>
            )}
          </div>
        </div>

        {/* Resize handle - only visible on desktop when sidebar is open */}
        {isDesktopSidebarOpen && (
          <div
            className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-light-gray/60 z-10 hidden md:block"
            onMouseDown={handleMouseDown}
          />
        )}
      </aside>
    </>
  );
}
