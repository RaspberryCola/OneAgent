import { useEffect, useMemo, useState, type RefObject } from "react";
import { Bot, Loader2 } from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { useAppStore } from "./lib/store";
import * as API from "./lib/backend/commands";
import { randomId } from "./lib/utils/randomId";
import type * as Types from "./lib/backend/types";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { SearchOverlay } from "./components/search/SearchOverlay";
import { WorkspaceSidebar } from "./components/sidebar/WorkspaceSidebar";
import { WorkspacePanel } from "./components/workspace/WorkspacePanel";
import { AppShell } from "./screens/app/AppShell";
import { ConversationScreen } from "./screens/conversation/ConversationScreen";
import { HomeScreen } from "./screens/home/HomeScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { IS_TAURI } from "./lib/backend/transport";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { BrowserPanel } from "./components/browser/BrowserPanel";
import { useScrollManager, useAttachmentHandler, useModelSelector, useModeSelector, useWorkspaceFileTree, useGitDiff, useSearch, useConversationComposer } from "./hooks";

const AGENT_LOGOS: Record<string, string> = {
  // providers
  anthropic: "/logos/providers/anthropic.svg",
  qwen: "/logos/providers/qwen.svg",
  openai: "/logos/providers/openai.svg",
  gemini: "/logos/providers/gemini.svg",
  deepseek: "/logos/providers/deepseek.svg",
  mistral: "/logos/providers/mistral.svg",
  tencent: "/logos/providers/tencent.svg",
  kimi: "/logos/providers/kimi.svg",
  baidu: "/logos/providers/baidu.svg",
  zhipu: "/logos/providers/zhipu.svg",
  minimax: "/logos/providers/minimax.png",
  volcengine: "/logos/providers/volcengine.svg",
  stepfun: "/logos/providers/stepfun.svg",
  lingyiwanwu: "/logos/providers/lingyiwanwu.svg",
  // agents
  claude: "/logos/agents/claude.svg",
  copilot: "/logos/agents/copilot.svg",
  codex: "/logos/agents/codex.svg",
  cursor: "/logos/agents/cursor.svg",
  goose: "/logos/agents/goose.svg",
  opencode: "/logos/agents/opencode.svg",
  qoder: "/logos/agents/qoder.png",
  qodercli: "/logos/agents/qoder.png",
  augment: "/logos/agents/auggie.svg",
  auggie: "/logos/agents/auggie.svg",
  droid: "/logos/agents/droid.svg",
  factory: "/logos/agents/droid.svg",
  hermes: "/logos/agents/hermes.svg",
  codebuddy: "/logos/agents/codebuddy.svg",
  iflow: "/logos/agents/iflow.svg",
  nanobot: "/logos/agents/nanobot.svg",
  openclaw: "/logos/agents/openclaw.svg",
};

type AgentLogoSource =
  | Pick<Types.AgentProfile, "command" | "name" | "package_name" | "display_source">
  | Pick<Types.AgentDiscoveryStatus, "command" | "name" | "source">
  | string;

function getAgentLogo(agent: AgentLogoSource) {
  const cmd = typeof agent === "string"
    ? agent.toLowerCase()
    : `${agent.command} ${agent.name} ${"package_name" in agent ? agent.package_name ?? "" : ""} ${
        "display_source" in agent ? agent.display_source : agent.source
      }`.toLowerCase();
  for (const key in AGENT_LOGOS) {
    if (cmd.includes(key)) return AGENT_LOGOS[key];
  }
  return null;
}

function getWorkspaceLabel(workspace: Types.Workspace | null | undefined): string {
  if (!workspace) return "Workspace";
  const normalizedPath = workspace.cwd.replace(/\\/g, "/");
  if (normalizedPath.includes(".oneagent/workspace")) {
    return "Default";
  }
  return workspace.display_name;
}

function AgentLogo({
  agent,
  className = "w-4 h-4",
}: {
  agent: AgentLogoSource;
  className?: string;
}) {
  const logo = getAgentLogo(agent);
  if (logo) {
    const alt = typeof agent === "string" ? agent : agent.name;
    return <img src={logo} alt={alt} className={`${className} object-contain`} />;
  }
  return <Bot className={className} />;
}

function formatDiscoveryNotice(status: Types.AgentDiscoveryStatus | null | undefined): string | null {
  if (!status) return null;
  if (status.availability === "ready" || status.availability === "degraded") return null;
  if (status.detail?.trim()) return status.detail;
  return "This agent is currently unavailable.";
}

function statusMeta(
  runtime?: Types.ConversationRuntimeState | null,
  fallbackStatus?: Types.Conversation["status"],
) {
  if (runtime) {
    if (runtime.turn_phase === "cancelling") {
      return { label: "Cancelling", dot: "bg-amber-500", pulse: true };
    }
    if (runtime.turn_phase === "failed") {
      return { label: "Failed", dot: "bg-rose-500", pulse: false };
    }
    if (runtime.turn_phase === "running") {
      return { label: "Running", dot: "bg-blue-500", pulse: true };
    }
    // Idle phase — check session/connection state
    if (runtime.session_phase === "loading") {
      return { label: "Recovering", dot: "bg-amber-500", pulse: true };
    }
    if (runtime.session_phase === "hot") {
      return { label: "Connected", dot: "bg-emerald-500", pulse: false };
    }
    if (runtime.connection_phase === "initializing") {
      return { label: "Initializing", dot: "bg-amber-500", pulse: true };
    }
    return { label: "Sleep", dot: "bg-black", pulse: false };
  }

  switch (fallbackStatus) {
    case "sleep":
      return { label: "Sleep", dot: "bg-black", pulse: false };
    case "initializing":
    case "starting":
      return { label: "Initializing", dot: "bg-amber-500", pulse: true };
    case "recovering":
      return { label: "Recovering", dot: "bg-amber-500", pulse: true };
    case "running":
      return { label: "Running", dot: "bg-blue-500", pulse: true };
    case "connected":
    case "ready":
    case "idle":
      return { label: "Connected", dot: "bg-emerald-500", pulse: false };
    case "failed":
      return { label: "Failed", dot: "bg-rose-500", pulse: false };
    case "cancelling":
      return { label: "Cancelling", dot: "bg-amber-500", pulse: true };
    case "cancelled":
      return { label: "Cancelled", dot: "bg-stone-400", pulse: false };
    default:
      return null;
  }
}

function compareIsoTimestamp(a?: string | null, b?: string | null) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;

  const aMillis = Date.parse(a);
  const bMillis = Date.parse(b);
  if (aMillis !== bMillis) return aMillis - bMillis;

  const aFraction = (a.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] ?? "").padEnd(9, "0").slice(0, 9);
  const bFraction = (b.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] ?? "").padEnd(9, "0").slice(0, 9);
  if (aFraction !== bFraction) return aFraction.localeCompare(bFraction);

  return a.localeCompare(b);
}

// Helper: get latest permission decision for a tool call
function getLatestPermissionDecision(
  toolCallId: string,
  decisions: Types.PermissionDecision[],
): Types.PermissionDecision | null {
  return decisions
    .filter((record) => record.tool_call_id === toolCallId)
    .sort((a, b) => compareIsoTimestamp(a.created_at, b.created_at))
    .at(-1) ?? null;
}

export default function App() {
  const [isMobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isDesktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | 'agents' | 'mcp' | 'im' | 'browser'>('general');
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [pendingDeleteConversationId, setPendingDeleteConversationId] = useState<string | null>(null);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());
  const [permissionDecisions, setPermissionDecisions] = useState<Types.PermissionDecision[]>([]);


  const {
    scrollAreaRef,
    scrollContentRef,
    setScrollAreaRef,
    scrollToBottom,
    forceScrollToBottom,
    showScrollButton,
    userHasScrolledUp,
  } = useScrollManager();

  const {
    isInitializing,
    isAuthenticated,
    init,
    workspaces,
    activeWorkspace,
    workspaceConversations,
    agentDiscoveryStatus,
    agentProfiles,
    activeAgentProfileId,
    conversations,
    activeConversationId,
    activeConversationState,
    activeTimeline,
    activeTimelineItems,
    unreadCompletedConversations,
    selectConversation,
    setActiveAgentProfile,
    ensureAgentCapabilities,
    sendMessage,
    deleteConversation,
    cancelTurn,
    switchWorkspace,
    pickWorkspace,
    archiveWorkspace,
    alwaysExpandThinking,
    setAlwaysExpandThinking,
    showAgentIconInList,
    setShowAgentIconInList,
    webuiEnabled,
    webuiPassword,
    webuiInfo,
    setWebuiEnabled,
    logout,
  } = useAppStore();

  const activeAgent = agentProfiles.find((agent) => agent.id === activeAgentProfileId) ?? null;
  const activeCapabilities = activeAgent?.capabilities_cache ?? null;

  useEffect(() => {
    if (!activeAgentProfileId || activeCapabilities?.prompt_capabilities) return;
    let cancelled = false;
    void ensureAgentCapabilities(activeAgentProfileId).catch((error) => {
      if (cancelled) return;
      console.error('Failed to auto-probe agent capabilities', error);
    });
    return () => {
      cancelled = true;
    };
  }, [activeAgentProfileId, activeCapabilities?.prompt_capabilities, ensureAgentCapabilities]);

  const {
    attachments,
    isAddingAttachment,
    attachmentStates,
    blockedAttachment,
    canSend: canSendAttachments,
    removeAttachment,
    setAttachmentUsageIntent,
    handleFileInput,
    handleDrop,
    handlePaste,
    resetAttachments,
    fileInputRef,
  } = useAttachmentHandler({
    agentProfileId: activeAgentProfileId ?? null,
    capabilities: activeCapabilities,
    adapterKind: activeAgent?.kind ?? null,
    onNotice: setComposerNotice,
  });

  const {
    modelSelector,
    selectedValue: selectedModelValue,
    selectedLabel: selectedModelLabel,
    isSetting: isSettingModel,
    handleModelChange,
  } = useModelSelector({ enabled: true, onNotice: setComposerNotice });

  const {
    isPanelOpen: isWorkspacePanelOpen,
    setIsPanelOpen: setIsWorkspacePanelOpen,
    rootFiles: workspaceRootFiles,
    isRootLoading: isWorkspaceRootLoading,
    rootError: workspaceRootError,
    expandedDirs: expandedWorkspaceDirs,
    dirChildren: workspaceDirChildren,
    loadingDirs: workspaceLoadingDirs,
    dirErrors: workspaceDirErrors,
    toggleDirectory: toggleWorkspaceDirectory,
    selectedFile: workspaceSelectedFile,
    selectFile: workspaceSelectFile,
    clearSelection: workspaceClearSelection,
    contextMenuState: workspaceContextMenuState,
    showContextMenu: workspaceShowContextMenu,
    hideContextMenu: workspaceHideContextMenu,
  } = useWorkspaceFileTree({
    workspaceId: activeWorkspace?.id ?? null,
    cwd: activeWorkspace?.cwd ?? null,
    enabled: true,
  });

  const {
    data: gitDiffData,
    isLoading: isGitDiffLoading,
    error: gitDiffError,
    errorType: gitDiffErrorType,
    refresh: refreshGitDiff,
  } = useGitDiff({
    cwd: activeWorkspace?.cwd ?? null,
    enabled: isWorkspacePanelOpen,
  });

  const {
    isOpen: isSearchOpen,
    query: searchQuery,
    results: searchResults,
    isSearching,
    openSearch,
    closeSearch,
    setQuery: setSearchQuery,
  } = useSearch({
    workspaceId: activeWorkspace?.id ?? null,
    enabled: true,
  });

  useEffect(() => {
    init();
  }, [init]);

  // Auto-expand current workspace
  useEffect(() => {
    if (activeWorkspace?.id) {
      setExpandedWorkspaces((prev) => {
        const next = new Set(prev);
        next.add(activeWorkspace.id);
        return next;
      });
    }
  }, [activeWorkspace?.id]);

  // Sync conversation state with workspace panel
  useEffect(() => {
    if (activeConversationId === null && isWorkspacePanelOpen) {
      setIsWorkspacePanelOpen(false);
    }
  }, [activeConversationId, isWorkspacePanelOpen]);

  useEffect(() => {
    return () => {
      attachments.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
    };
  }, [attachments]);

  useEffect(() => {
    if (!activeConversationId) {
      setPermissionDecisions([]);
      return;
    }

    let cancelled = false;
    void API.listPermissions(activeConversationId)
      .then((records) => {
        if (!cancelled) {
          setPermissionDecisions(records);
        }
      })
      .catch((error) => {
        console.error("Failed to list permission decisions", error);
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeConversationId,
    activeTimeline?.pending_permissions
      .map((request) => `${request.id}:${request.status}:${request.resolved_at ?? ""}`)
      .join("|"),
  ]);

  const sortedDiscoveryStatus = useMemo(() => {
    const order = { ready: 0, degraded: 1, unavailable: 2 };
    return [...agentDiscoveryStatus].sort((a, b) => order[a.availability] - order[b.availability]);
  }, [agentDiscoveryStatus]);

  const activeDiscoveryStatus =
    agentDiscoveryStatus.find((status) => status.profile_id === activeAgentProfileId)
    ?? agentDiscoveryStatus.find((status) => status.command === activeAgent?.command);
  const availableAgents = agentDiscoveryStatus.filter((agent) => agent.installed);
  const isWorkspaceLocked = activeConversationId !== null;
  const currentConversation =
    activeConversationState?.conversation ??  // 优先使用实时轮询的状态
    conversations.find((conversation) => conversation.id === activeConversationId) ??  // 其次使用列表缓存
    null;
  const conversationStatus = statusMeta(activeConversationState?.runtime, currentConversation?.status);
  const isConversationBusy = conversationStatus?.pulse ?? false;

  useEffect(() => {
    if (activeConversationId || !activeAgentProfileId) return;
    setComposerNotice(formatDiscoveryNotice(activeDiscoveryStatus));
  }, [activeConversationId, activeAgentProfileId, activeDiscoveryStatus]);

  const {
    activeModeState,
    selectedValue: selectedModeValue,
    selectedLabel: selectedModeLabel,
    isSetting: isSettingMode,
    handleModeChange,
  } = useModeSelector({ onNotice: setComposerNotice });

  const {
    input,
    setInput,
    canSend,
    isBusy,
    resetComposer,
    handleSend,
    handleStop,
    handleKeyDown,
    handleCompositionStart,
    handleCompositionEnd,
  } = useConversationComposer({
    activeConversationId,
    activeAgentProfileId,
    isConversationBusy,
    canSendAttachments,
    blockedAttachment,
    isAddingAttachment,
    attachmentStates,
    resetAttachments,
    modelSelector,
    selectedModelValue,
    activeModeState,
    selectedModeValue,
    sendMessage,
    cancelTurn,
    setComposerNotice,
  });

  // Terminal states & handlers
  const [terminalTabs, setTerminalTabs] = useState<{ id: string; name: string; cwd: string }[]>([]);
  const [activeTerminalTabId, setActiveTerminalTabId] = useState<string | null>(null);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [nextTerminalNum, setNextTerminalNum] = useState(2);

  useEffect(() => {
    if (activeWorkspace) {
      const initialId = randomId();
      setTerminalTabs([
        {
          id: initialId,
          name: 'Terminal 1',
          cwd: activeWorkspace.cwd,
        },
      ]);
      setActiveTerminalTabId(initialId);
      setNextTerminalNum(2);
    } else {
      setTerminalTabs([]);
      setActiveTerminalTabId(null);
      setNextTerminalNum(1);
    }
  }, [activeWorkspace?.id]);

  const handleAddTerminalTab = () => {
    if (!activeWorkspace) return;
    const newId = randomId();
    const newTab = {
      id: newId,
      name: `Terminal ${nextTerminalNum}`,
      cwd: activeWorkspace.cwd,
    };
    setTerminalTabs((prev) => [...prev, newTab]);
    setActiveTerminalTabId(newId);
    setNextTerminalNum((prev) => prev + 1);
  };

  const handleCloseTerminalTab = (id: string) => {
    setTerminalTabs((prev) => {
      const filtered = prev.filter((t) => t.id !== id);
      if (activeTerminalTabId === id) {
        if (filtered.length > 0) {
          const closedIndex = prev.findIndex((t) => t.id === id);
          const nextActiveIndex = Math.min(closedIndex, filtered.length - 1);
          setActiveTerminalTabId(filtered[nextActiveIndex].id);
        } else {
          setActiveTerminalTabId(null);
        }
      }
      return filtered;
    });
  };

  const handleToggleTerminal = () => {
    setIsTerminalOpen((prev) => {
      const next = !prev;
      if (next && terminalTabs.length === 0 && activeWorkspace) {
        const initialId = randomId();
        setTerminalTabs([
          {
            id: initialId,
            name: 'Terminal 1',
            cwd: activeWorkspace.cwd,
          },
        ]);
        setActiveTerminalTabId(initialId);
        setNextTerminalNum(2);
      }
      return next;
    });
  };

  // Browser panel state
  const [isBrowserOpen, setIsBrowserOpen] = useState(false);
  const handleToggleBrowser = () => setIsBrowserOpen((prev) => !prev);

  // Calculate the last agent text message ID for each turn (for copy functionality)
  // Exclude the currently running turn (if any) from showing copy button
  const lastAgentMessageIdsPerTurn = useMemo(() => {
    const turnLastAgentMessages = new Map<string, string>();

    // Find the current running turn_id (if any) - use the latest agent message's turn_id when busy
    let activeTurnId: string | null = null;
    if (isBusy) {
      // Find the latest agent text message's turn_id
      const agentMessages = activeTimelineItems
        .filter((item) => item.type === 'message')
        .map((item) => item.data as Types.MessageProjection)
        .filter((msg) => msg.role === 'agent' && msg.kind === 'text' && msg.turn_id);

      if (agentMessages.length > 0) {
        // Get the last agent message (sorted by created_at)
        const lastAgentMessage = agentMessages[agentMessages.length - 1];
        activeTurnId = lastAgentMessage.turn_id;
      }
    }

    // Group messages by turn_id and find the last agent text message in each turn
    activeTimelineItems
      .filter((item) => item.type === 'message')
      .forEach((item) => {
        const msg = item.data as Types.MessageProjection;
        if (msg.role === 'agent' && msg.kind === 'text' && msg.turn_id) {
          // Skip the currently active turn - don't show copy button until turn is finished
          if (msg.turn_id === activeTurnId) {
            return;
          }
          // Update the last agent message for this turn (will be the last one after iteration)
          turnLastAgentMessages.set(msg.turn_id, msg.id);
        }
      });

    return turnLastAgentMessages;
  }, [activeTimelineItems, isBusy]);

  // Auto-scroll to bottom on message updates
  useEffect(() => {
    // When agent is busy (streaming), only auto-scroll if user hasn't manually scrolled up
    if (isBusy) {
      if (!userHasScrolledUp) {
        forceScrollToBottom();
      }
      return;
    }

    // When not busy, scroll to bottom only if user hasn't manually scrolled up
    if (!userHasScrolledUp) {
      scrollToBottom();
    }
  }, [activeTimeline?.messages, isBusy, userHasScrolledUp, forceScrollToBottom, scrollToBottom]);

  useEffect(() => {
    const content = scrollContentRef.current;
    if (!content) return;

    const shouldStickToBottom = () => !userHasScrolledUp;
    const syncToBottom = () => {
      if (!shouldStickToBottom()) return;
      forceScrollToBottom();
    };

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        syncToBottom();
      });
      observer.observe(content);
      return () => observer.disconnect();
    }

    const timer = window.setTimeout(syncToBottom, 100);
    return () => window.clearTimeout(timer);
  }, [isBusy, activeConversationId, userHasScrolledUp, forceScrollToBottom]);

  useEffect(() => {
    scrollToBottom();
  }, [activeConversationId, scrollToBottom]);

  const permissionRequestMeta = useMemo(() => {
    const meta = new Map<
      string,
      {
        toolKind?: string;
        title?: string;
        paths?: string[];
        rawInput?: any;
      }
    >();

    activeTimeline?.events.forEach((event) => {
      if (event.event_type !== "PermissionRequested") return;
      const payload = event.payload_json ?? {};
      const requestId = typeof payload.request_id === "string" ? payload.request_id : null;
      const toolCallId = typeof payload.tool_call_id === "string" ? payload.tool_call_id : null;
      const key = requestId ?? toolCallId;
      if (!key) return;

      meta.set(key, {
        toolKind: typeof payload.tool_kind === "string" ? payload.tool_kind : undefined,
        title: typeof payload.title === "string" ? payload.title : undefined,
        paths: Array.isArray(payload.paths) ? payload.paths.filter((item: unknown): item is string => typeof item === "string") : undefined,
        rawInput: payload.raw_input,
      });
    });

    return meta;
  }, [activeTimeline?.events]);

  if (isInitializing) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-pure-white text-pure-black">
        <Loader2 className="w-6 h-6 animate-spin text-stone" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  return (
    <div className="flex h-dvh w-full bg-pure-white font-body text-pure-black selection:bg-light-gray overflow-hidden">
      <input
        ref={fileInputRef as RefObject<HTMLInputElement>}
        type="file"
        multiple
        accept="image/*,audio/*,text/*,.json,.yaml,.yml,.xml,.js,.ts,.jsx,.tsx,.sh,.md,.csv,.pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.zip"
        className="hidden"
        onChange={handleFileInput}
      />

      <WorkspaceSidebar
        isMobileSidebarOpen={isMobileSidebarOpen}
        isDesktopSidebarOpen={isDesktopSidebarOpen}
        workspaces={workspaces}
        workspaceConversations={workspaceConversations}
        expandedWorkspaces={expandedWorkspaces}
        activeConversationId={activeConversationId}
        unreadCompletedConversations={unreadCompletedConversations}
        pendingDeleteConversationId={pendingDeleteConversationId}
        agentProfiles={agentProfiles}
        getWorkspaceLabel={getWorkspaceLabel}
        renderAgentLogo={(agentCommand, className) => (
          <AgentLogo agent={agentCommand} className={className} />
        )}
        showAgentIcon={showAgentIconInList}
        onCloseMobileSidebar={() => setMobileSidebarOpen(false)}
        onCloseDesktopSidebar={() => setDesktopSidebarOpen(false)}
        onNewChat={() => {
          void selectConversation(null);
          resetComposer();
        }}
        onOpenSearch={openSearch}
        onOpenWorkspacePicker={() => void pickWorkspace()}
        onToggleWorkspaceExpand={(workspaceId) => {
          setExpandedWorkspaces((prev) => {
            const next = new Set(prev);
            if (next.has(workspaceId)) {
              next.delete(workspaceId);
            } else {
              next.add(workspaceId);
            }
            return next;
          });
        }}
        onStartWorkspaceChat={(workspace) => {
          void switchWorkspace(workspace).then(() => {
            void selectConversation(null);
            resetComposer();
            setPendingDeleteConversationId(null);
          });
        }}
        onSelectConversation={(conversationId) => {
          void selectConversation(conversationId);
          setComposerNotice(null);
          setPendingDeleteConversationId(null);
        }}
        onToggleDeleteConversation={(conversationId) => {
          if (pendingDeleteConversationId === conversationId) {
            setPendingDeleteConversationId(null);
            void deleteConversation(conversationId);
            return;
          }
          setPendingDeleteConversationId(conversationId);
        }}
        onCancelDeleteConversation={(conversationId) => {
          setPendingDeleteConversationId((current) => (current === conversationId ? null : current));
        }}
        onArchiveWorkspace={archiveWorkspace}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onLogout={!IS_TAURI ? logout : undefined}
      />

      <AppShell
        activeConversationId={activeConversationId}
        activeAgent={activeAgent}
        conversationStatus={conversationStatus}
        isDesktopSidebarOpen={isDesktopSidebarOpen}
        isWorkspacePanelOpen={isWorkspacePanelOpen}
        composerNotice={composerNotice}
        onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
        onOpenDesktopSidebar={() => setDesktopSidebarOpen(true)}
        onToggleWorkspacePanel={() => setIsWorkspacePanelOpen(!isWorkspacePanelOpen)}
        onDismissComposerNotice={() => setComposerNotice(null)}
        renderAgentLogo={(agent, className) => (
          <AgentLogo agent={agent} className={className} />
        )}
        hasWorkspace={!!activeWorkspace}
        isTerminalOpen={isTerminalOpen}
        onToggleTerminal={handleToggleTerminal}
        terminalContent={
          <TerminalPanel
            isOpen={isTerminalOpen}
            onClose={() => setIsTerminalOpen(false)}
            activeWorkspaceCwd={activeWorkspace?.cwd}
            tabs={terminalTabs}
            activeTabId={activeTerminalTabId}
            onAddTab={handleAddTerminalTab}
            onCloseTab={handleCloseTerminalTab}
            onSelectTab={setActiveTerminalTabId}
          />
        }
        isBrowserOpen={isBrowserOpen}
        onToggleBrowser={handleToggleBrowser}
        browserContent={
          <BrowserPanel
            isOpen={isBrowserOpen}
            onClose={() => setIsBrowserOpen(false)}
          />
        }
        homeContent={
          <HomeScreen
            workspaces={workspaces}
            activeWorkspace={activeWorkspace}
            activeAgent={activeAgent}
            activeAgentProfileId={activeAgentProfileId}
            agentProfiles={agentProfiles}
            availableAgentsCount={availableAgents.length}
            isWorkspaceLocked={isWorkspaceLocked}
            input={input}
            setInput={setInput}
            attachmentStates={attachmentStates}
            modelSelector={modelSelector}
            selectedModelValue={selectedModelValue}
            selectedModelLabel={selectedModelLabel}
            isSettingModel={isSettingModel}
            activeModeState={activeModeState}
            selectedModeValue={selectedModeValue}
            selectedModeLabel={selectedModeLabel}
            isSettingMode={isSettingMode}
            canSend={canSend}
            isBusy={isBusy}
            renderAgentLogo={(agent, className) => (
              <AgentLogo agent={agent} className={className} />
            )}
            onSelectWorkspace={(workspace) => void switchWorkspace(workspace)}
            onAddWorkspace={() => void pickWorkspace()}
            onSelectAgentProfile={(profileId) => {
              setActiveAgentProfile(profileId);
              setComposerNotice(null);
            }}
            onModelChange={(value) => void handleModelChange(value)}
            onModeChange={(value) => void handleModeChange(value)}
            onDrop={handleDrop}
            onPaste={handlePaste}
            onRemoveAttachment={removeAttachment}
            onSetAttachmentUsageIntent={setAttachmentUsageIntent}
            onSend={() => void handleSend()}
            onStop={() => void handleStop()}
            onAttachClick={() => fileInputRef.current?.click()}
            onKeyDown={handleKeyDown}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
          />
        }
        conversationContent={
          <ConversationScreen
            setScrollAreaRef={setScrollAreaRef}
            scrollContentRef={scrollContentRef}
            activeTimeline={activeTimeline}
            activeTimelineItems={activeTimelineItems}
            lastAgentMessageIdsPerTurn={lastAgentMessageIdsPerTurn}
            permissionDecisions={permissionDecisions}
            permissionRequestMeta={permissionRequestMeta}
            showScrollButton={showScrollButton}
            scrollToBottom={scrollToBottom}
            getLatestPermissionDecision={getLatestPermissionDecision}
            input={input}
            setInput={setInput}
            attachmentStates={attachmentStates}
            activeAgent={activeAgent}
            modelSelector={modelSelector}
            selectedModelValue={selectedModelValue}
            selectedModelLabel={selectedModelLabel}
            isSettingModel={isSettingModel}
            activeModeState={activeModeState}
            selectedModeValue={selectedModeValue}
            selectedModeLabel={selectedModeLabel}
            isSettingMode={isSettingMode}
            canSend={canSend}
            isBusy={isBusy}
            onModelChange={(value) => void handleModelChange(value)}
            onModeChange={(value) => void handleModeChange(value)}
            onAttachClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onPaste={handlePaste}
            onRemoveAttachment={removeAttachment}
            onSetAttachmentUsageIntent={setAttachmentUsageIntent}
            onSend={() => void handleSend()}
            onStop={() => void handleStop()}
            onKeyDown={handleKeyDown}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            availableCommands={activeConversationState?.available_commands}
          />
        }
        workspacePanel={activeConversationId !== null ? (
          <WorkspacePanel
            isOpen={isWorkspacePanelOpen}
            cwd={activeWorkspace?.cwd}
            isRootLoading={isWorkspaceRootLoading}
            rootError={workspaceRootError}
            rootFiles={workspaceRootFiles}
            expandedDirs={expandedWorkspaceDirs}
            dirChildren={workspaceDirChildren}
            loadingDirs={workspaceLoadingDirs}
            dirErrors={workspaceDirErrors}
            onToggleDirectory={toggleWorkspaceDirectory}
            gitDiffData={gitDiffData}
            isGitDiffLoading={isGitDiffLoading}
            gitDiffError={gitDiffError}
            gitDiffErrorType={gitDiffErrorType}
            onRefreshGitDiff={refreshGitDiff}
            selectedFile={workspaceSelectedFile}
            onSelectFile={workspaceSelectFile}
            onClearSelection={workspaceClearSelection}
            contextMenuState={workspaceContextMenuState}
            onShowContextMenu={workspaceShowContextMenu}
            onHideContextMenu={workspaceHideContextMenu}
            onNotice={setComposerNotice}
          />
        ) : null}
      />

      <AnimatePresence>
        {isSettingsOpen && (
          <SettingsDialog
            isOpen={isSettingsOpen}
            settingsTab={settingsTab}
            alwaysExpandThinking={alwaysExpandThinking}
            sortedDiscoveryStatus={sortedDiscoveryStatus}
            availableAgentsCount={availableAgents.length}
            activeWorkspaceId={activeWorkspace?.id ?? null}
            onClose={() => setIsSettingsOpen(false)}
            onSelectTab={setSettingsTab}
            onToggleAlwaysExpandThinking={() => setAlwaysExpandThinking(!alwaysExpandThinking)}
            showAgentIconInList={showAgentIconInList}
            onToggleShowAgentIconInList={() => setShowAgentIconInList(!showAgentIconInList)}
            renderAgentLogo={(agent, className) => (
              <AgentLogo agent={agent} className={className} />
            )}
            webuiEnabled={webuiEnabled}
            webuiPassword={webuiPassword}
            webuiInfo={webuiInfo}
            onToggleWebuiEnabled={() => setWebuiEnabled(!webuiEnabled)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isSearchOpen && (
          <SearchOverlay
            query={searchQuery}
            setQuery={setSearchQuery}
            results={searchResults}
            isSearching={isSearching}
            agentProfiles={agentProfiles}
            renderAgentLogo={(agent, className) => (
              <AgentLogo agent={agent} className={className} />
            )}
            onClose={closeSearch}
            onSelect={(id) => {
              void selectConversation(id);
              closeSearch();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
