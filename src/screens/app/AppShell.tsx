import type { ReactNode } from 'react';
import { AlertCircle, Globe, Menu, PanelLeftClose, PanelLeftOpen, Terminal, X } from 'lucide-react';
import type * as Types from '../../lib/backend/types';

interface ConversationStatus {
  label: string;
  dot: string;
  pulse: boolean;
}

interface AppShellProps {
  activeConversationId: string | null;
  activeAgent: Types.AgentProfile | null;
  conversationStatus: ConversationStatus | null;
  isDesktopSidebarOpen: boolean;
  isWorkspacePanelOpen: boolean;
  composerNotice: string | null;
  onOpenMobileSidebar: () => void;
  onOpenDesktopSidebar: () => void;
  onToggleWorkspacePanel: () => void;
  onDismissComposerNotice: () => void;
  renderAgentLogo: (agent: Types.AgentProfile, className: string) => ReactNode;
  homeContent: ReactNode;
  conversationContent: ReactNode;
  workspacePanel: ReactNode;
  
  // Terminal props
  hasWorkspace: boolean;
  isTerminalOpen: boolean;
  onToggleTerminal: () => void;
  terminalContent: ReactNode;

  // Browser props
  isBrowserOpen: boolean;
  onToggleBrowser: () => void;
  browserContent: ReactNode;
}

export function AppShell({
  activeConversationId,
  activeAgent,
  conversationStatus,
  isDesktopSidebarOpen,
  isWorkspacePanelOpen,
  composerNotice,
  onOpenMobileSidebar,
  onOpenDesktopSidebar,
  onToggleWorkspacePanel,
  onDismissComposerNotice,
  renderAgentLogo,
  homeContent,
  conversationContent,
  workspacePanel,
  
  // Terminal destructuring
  hasWorkspace,
  isTerminalOpen,
  onToggleTerminal,
  terminalContent,
  
  // Browser destructuring
  isBrowserOpen,
  onToggleBrowser,
  browserContent,
}: AppShellProps) {
  return (
    <>
      <main className="flex-1 flex flex-col min-w-0 h-dvh bg-pure-white relative">
        <header className="h-14 flex items-center justify-between px-4 shrink-0 bg-pure-white z-10 w-full">
          <div className="flex items-center gap-3 min-w-0">
            <button className="md:hidden p-2.5 shrink-0 text-stone hover:text-pure-black rounded-interactive hover:bg-snow transition-colors min-h-[44px] flex items-center justify-center" onClick={onOpenMobileSidebar}>
              <Menu className="w-5 h-5" />
            </button>
            {!isDesktopSidebarOpen && (
              <button
                className="hidden md:flex p-2 shrink-0 text-stone hover:text-pure-black rounded-interactive hover:bg-snow transition-colors"
                onClick={onOpenDesktopSidebar}
                title="Open Sidebar"
              >
                <PanelLeftOpen className="w-5 h-5" />
              </button>
            )}
            {activeConversationId && activeAgent && (
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-8 h-8 flex items-center justify-center shrink-0">
                    {renderAgentLogo(activeAgent, 'w-5 h-5 object-contain')}
                  </div>
                  <span className="font-display font-medium text-bodyLarge truncate">{activeAgent.name}</span>
                </div>
                {conversationStatus && (
                  <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-interactive bg-snow border border-light-gray animate-in fade-in slide-in-from-left-1 duration-300">
                    <div className={`w-1.5 h-1.5 rounded-full ${conversationStatus.dot} ${conversationStatus.pulse ? 'animate-pulse' : ''}`} />
                    <span className="text-[11px] font-medium text-stone uppercase tracking-tight">{conversationStatus.label}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {hasWorkspace && (
              <button
                type="button"
                onClick={onToggleTerminal}
                className={`md:min-h-0 min-h-[44px] p-2 shrink-0 rounded-interactive transition-colors hover:bg-light-gray/50 ${
                  isTerminalOpen ? 'text-pure-black' : 'text-stone hover:text-pure-black'
                }`}
                title="Toggle terminal"
                aria-label="Toggle terminal"
              >
                <Terminal className="w-[18px] h-[18px]" />
              </button>
            )}

            {hasWorkspace && (
              <button
                type="button"
                onClick={onToggleBrowser}
                className={`md:min-h-0 min-h-[44px] p-2 shrink-0 rounded-interactive transition-colors hover:bg-light-gray/50 ${
                  isBrowserOpen ? 'text-pure-black' : 'text-stone hover:text-pure-black'
                }`}
                title="Toggle browser panel"
                aria-label="Toggle browser panel"
              >
                <Globe className="w-[18px] h-[18px]" />
              </button>
            )}

            {activeConversationId && (
              <button
                type="button"
                onClick={onToggleWorkspacePanel}
                className={`md:min-h-0 min-h-[44px] p-2 shrink-0 rounded-interactive transition-colors hover:bg-light-gray/50 ${
                  isWorkspacePanelOpen ? 'text-pure-black' : 'text-stone hover:text-pure-black'
                }`}
                title="Toggle workspace panel"
                aria-label="Toggle workspace panel"
              >
                {isWorkspacePanelOpen ? (
                  <PanelLeftClose className="w-[18px] h-[18px] -scale-x-100" />
                ) : (
                  <PanelLeftOpen className="w-[18px] h-[18px] -scale-x-100" />
                )}
              </button>
            )}
          </div>
        </header>
 
        {composerNotice && (
          <div className="absolute top-4 left-0 right-0 z-50 flex justify-center pointer-events-none">
            <div className="pointer-events-auto flex items-center gap-2 rounded-container border border-light-gray bg-pure-white shadow-lg px-4 py-3 text-[13px] text-near-black max-w-[768px] mx-4">
              <AlertCircle className="w-4 h-4 shrink-0 text-stone" />
              <span className="truncate">{composerNotice}</span>
              <button
                onClick={onDismissComposerNotice}
                className="ml-1 p-1 text-stone hover:text-pure-black rounded-interactive hover:bg-light-gray/50 transition-colors shrink-0"
                title="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {activeConversationId === null ? homeContent : conversationContent}
        {terminalContent}
      </main>

      {browserContent}
      {workspacePanel}
    </>
  );
}
