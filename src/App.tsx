import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  Bot,
  Loader2,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useAppStore } from "./lib/store";
import * as API from "./lib/backend/commands";
import type * as Types from "./lib/backend/types";
import { ThoughtDisplay } from "./components/chat/ThoughtDisplay";
import { ToolCallDisplay } from "./components/chat/ToolCallDisplay";
import { PermissionDisplay } from "./components/chat/PermissionDisplay";
import { Composer } from "./components/composer/Composer";
import { SearchOverlay } from "./components/search/SearchOverlay";
import { WorkspaceSidebar } from "./components/sidebar/WorkspaceSidebar";
import { TimelineMessage } from "./components/timeline/TimelineMessage";
import { WorkspaceDropdown } from "./components/ui/WorkspaceDropdown";
import { WorkspacePanel } from "./components/workspace/WorkspacePanel";
import { useScrollManager, useAttachmentHandler, useModelSelector, useModeSelector, useWorkspaceFileTree, useSearch, useConversationComposer } from "./hooks";

const AGENT_LOGOS: Record<string, string> = {
  claude: "/logos/ai-major/claude.svg",
  anthropic: "/logos/ai-major/anthropic.svg",
  qwen: "/logos/ai-china/qwen.svg",
  openai: "/logos/ai-major/openai.svg",
  gemini: "/logos/ai-major/gemini.svg",
  deepseek: "/logos/ai-major/deepseek.svg",
  mistral: "/logos/ai-major/mistral.svg",
  github: "/logos/tools/github.svg",
  copilot: "/logos/tools/github.svg",
  tencent: "/logos/ai-china/tencent.svg",
  kimi: "/logos/ai-china/kimi.svg",
  baidu: "/logos/ai-china/baidu.svg",
  zhipu: "/logos/ai-china/zhipu.svg",
  minimax: "/logos/ai-china/minimax.png",
  volcengine: "/logos/ai-china/volcengine.svg",
  stepfun: "/logos/ai-china/stepfun.svg",
  lingyiwanwu: "/logos/ai-china/lingyiwanwu.svg",
  goose: "/logos/tools/goose.svg",
  openclaw: "/logos/tools/openclaw.svg",
  opencode: "/logos/tools/coding/opencode.svg",
  qoder: "/logos/tools/coding/qoder.png",
  qodercli: "/logos/tools/coding/qoder.png",
  augment: "/logos/brand/auggie.svg",
  auggie: "/logos/brand/auggie.svg",
  droid: "/logos/brand/droid.svg",
  factory: "/logos/brand/droid.svg",
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
  const basename = normalizedPath.split("/").filter(Boolean).at(-1) ?? "";
  if (workspace.display_name === ".oneagent" || basename === ".oneagent") {
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
    return { label: "Sleep", dot: "bg-stone-400", pulse: false };
  }

  switch (fallbackStatus) {
    case "sleep":
      return { label: "Sleep", dot: "bg-stone-400", pulse: false };
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
  const [settingsTab, setSettingsTab] = useState<'general' | 'agents' | 'mcp'>('general');
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
    sendMessage,
    deleteConversation,
    cancelTurn,
    switchWorkspace,
    pickWorkspace,
    alwaysExpandThinking,
    setAlwaysExpandThinking,
  } = useAppStore();

  const activeAgent = agentProfiles.find((agent) => agent.id === activeAgentProfileId) ?? null;
  const activeCapabilities = activeAgent?.capabilities_cache ?? null;

  const {
    attachments,
    isAddingAttachment,
    attachmentStates,
    blockedAttachment,
    canSend: canSendAttachments,
    removeAttachment,
    handleFileInput,
    handleDrop,
    handlePaste,
    resetAttachments,
    fileInputRef,
  } = useAttachmentHandler({
    agentProfileId: activeAgentProfileId ?? null,
    capabilities: activeCapabilities,
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
  } = useWorkspaceFileTree({
    workspaceId: activeWorkspace?.id ?? null,
    cwd: activeWorkspace?.cwd ?? null,
    enabled: true,
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
      <div className="flex h-screen w-full items-center justify-center bg-pure-white text-pure-black">
        <Loader2 className="w-6 h-6 animate-spin text-stone" />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-pure-white font-body text-pure-black selection:bg-light-gray overflow-hidden">
      <input ref={fileInputRef as React.Ref<HTMLInputElement>} type="file" multiple className="hidden" onChange={handleFileInput} />

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
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      <main className="flex-1 flex flex-col min-w-0 h-screen bg-pure-white relative">
        <header className="h-14 flex items-center justify-between px-4 shrink-0 bg-pure-white z-10 w-full">
          <div className="flex items-center gap-3 min-w-0">
            <button className="md:hidden p-2 shrink-0 text-stone hover:text-pure-black rounded-md hover:bg-snow transition-colors" onClick={() => setMobileSidebarOpen(true)}>
              <Menu className="w-5 h-5" />
            </button>
            {!isDesktopSidebarOpen && (
              <button
                className="hidden md:flex p-2 shrink-0 text-stone hover:text-pure-black rounded-md hover:bg-snow transition-colors"
                onClick={() => setDesktopSidebarOpen(true)}
                title="Open Sidebar"
              >
                <PanelLeftOpen className="w-5 h-5" />
              </button>
            )}
            {activeConversationId && activeAgent && (
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-8 h-8 flex items-center justify-center shrink-0">
                    <AgentLogo agent={activeAgent} className="w-5 h-5 object-contain" />
                  </div>
                  <span className="font-display font-medium text-bodyLarge truncate">{activeAgent.name}</span>
                </div>
                {conversationStatus && (
                  <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-pill bg-snow border border-light-gray animate-in fade-in slide-in-from-left-1 duration-300">
                    <div className={`w-1.5 h-1.5 rounded-full ${conversationStatus.dot} ${conversationStatus.pulse ? 'animate-pulse' : ''}`} />
                    <span className="text-[11px] font-medium text-stone uppercase tracking-tight">{conversationStatus.label}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {activeConversationId && (
            <button
              type="button"
              onClick={() => setIsWorkspacePanelOpen(!isWorkspacePanelOpen)}
              className={`p-1 shrink-0 rounded-md transition-colors hover:bg-light-gray/50 ${
                isWorkspacePanelOpen ? "text-pure-black" : "text-stone hover:text-pure-black"
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
        </header>

        {/* Floating Notice Toast - 悬浮在右侧内容区顶部居中 */}
        {composerNotice && (
          <div className="absolute top-4 left-0 right-0 z-50 flex justify-center pointer-events-none">
            <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-light-gray bg-pure-white shadow-lg px-4 py-3 text-[13px] text-near-black max-w-[768px] mx-4">
              <AlertCircle className="w-4 h-4 shrink-0 text-stone" />
              <span className="truncate">{composerNotice}</span>
              <button
                onClick={() => setComposerNotice(null)}
                className="ml-1 p-1 text-stone hover:text-pure-black rounded-md hover:bg-light-gray/50 transition-colors shrink-0"
                title="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
        {activeConversationId === null ? (
          <div className="flex-1 flex flex-col items-center justify-center p-4 pb-32 w-full max-w-3xl mx-auto overflow-y-auto overflow-x-hidden">
            <div className="flex flex-col items-center mb-10 gap-8 w-full">
              <WorkspaceDropdown
                workspaces={workspaces}
                activeWorkspace={activeWorkspace}
                onSelectWorkspace={(workspace) => void switchWorkspace(workspace)}
                onAddWorkspace={() => void pickWorkspace()}
                disabled={isWorkspaceLocked}
              />
              <div className="flex flex-wrap items-center justify-center gap-2.5 w-full max-w-[768px]">
                {agentProfiles.map((profile) => {
                  const isActive = activeAgentProfileId === profile.id;
                  return (
                    <motion.button
                      layout
                      initial={false}
                      key={profile.id}
                      onClick={() => {
                        setActiveAgentProfile(profile.id);
                        setComposerNotice(null);
                      }}
                      className={`relative flex items-center justify-center rounded-pill transition-colors border ${
                        isActive
                          ? "border-pure-black text-pure-white px-4 h-[42px]"
                          : "border-light-gray bg-pure-white text-near-black hover:bg-snow hover:border-border-light w-[42px] h-[42px]"
                      }`}
                      style={{ WebkitTapHighlightColor: "transparent" }}
                      transition={{ type: "spring", stiffness: 500, damping: 35 }}
                    >
                      {isActive && (
                        <motion.div
                          layoutId="activeAgentPill"
                          className="absolute inset-0 bg-pure-black rounded-pill"
                          initial={false}
                          transition={{ type: "spring", stiffness: 500, damping: 35 }}
                        />
                      )}
                      <motion.div layout className="relative z-10 flex items-center gap-2.5">
                        <AgentLogo
                          agent={profile}
                          className={`w-5 h-5 object-contain shrink-0 transition-all duration-200 ${
                            isActive ? "brightness-0 invert" : "grayscale opacity-60 hover:opacity-100"
                          }`}
                        />
                        {isActive && (
                          <motion.span layout className="font-medium text-[15px] whitespace-nowrap">
                            {profile.name}
                          </motion.span>
                        )}
                      </motion.div>
                    </motion.button>
                  );
                })}
              </div>
              {availableAgents.length === 0 && (
                <div className="text-small text-stone text-center max-w-xl">
                  No available agent is ready yet. Claude Code can run from the bundled bridge when resources are present, or native ACP agents can be detected from your PATH.
                </div>
              )}
            </div>
            <div className="w-full flex">
              <div className="flex-1 min-w-0">
                <div className="max-w-[768px] mx-auto px-4 md:px-6">
                  <Composer
                    input={input}
                    setInput={setInput}
                    attachments={attachmentStates}
                    activeAgent={activeAgent}
                    modelSelector={modelSelector}
                    selectedModelValue={selectedModelValue}
                    selectedModelLabel={selectedModelLabel}
                    onModelChange={(value) => void handleModelChange(String(value))}
                    isSettingModel={isSettingModel}
                    activeModeState={activeModeState}
                    selectedModeValue={selectedModeValue}
                    selectedModeLabel={selectedModeLabel}
                    onModeChange={(value) => void handleModeChange(String(value))}
                    isSettingMode={isSettingMode}
                    onAttachClick={() => fileInputRef.current?.click()}
                    onDrop={handleDrop}
                    onPaste={handlePaste}
                    onRemoveAttachment={removeAttachment}
                    onSend={() => void handleSend()}
                    onKeyDown={handleKeyDown}
                    canSend={canSend}
                    isCompact={false}
                    isBusy={isBusy}
                    onStop={() => void handleStop()}
                  />
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div 
            ref={setScrollAreaRef}
            className="relative flex-1 overflow-y-auto min-w-0 w-full flex flex-col scroll-smooth scrollbar-chat"
          >
            <div ref={scrollContentRef} className="max-w-[768px] mx-auto w-full flex-1 flex flex-col min-h-full">
              <div className="flex-1 space-y-4 px-4 md:px-6 pt-4 pb-4">
                {activeTimelineItems.map((item) => {
                  if (item.type === 'message') {
                    const message = item.data;
                    if (message.kind === "thinking") {
                      return (
                        <ThoughtDisplay
                          key={message.id}
                          content={message.content_json?.text || ""}
                          status={message.content_json?.status || "done"}
                          duration_ms={message.content_json?.duration_ms}
                        />
                      );
                    }
                    return (
                      <TimelineMessage
                        key={message.id}
                        message={message}
                        terminals={activeTimeline?.terminals ?? []}
                        lastAgentMessageIdsPerTurn={lastAgentMessageIdsPerTurn}
                      />
                    );
                  } else if (item.type === 'tool_call') {
                    return (
                      <ToolCallDisplay
                        key={item.key}
                        toolCall={item.data}
                        terminals={(activeTimeline?.terminals ?? []).filter((terminal) =>
                          Array.isArray(item.data.terminal_ids_json) && item.data.terminal_ids_json.includes(terminal.terminal_id),
                        )}
                        permissionDecision={getLatestPermissionDecision(item.data.tool_call_id, permissionDecisions)}
                      />
                    );
                  }

                  // Permission items are only shown in the bottom sticky area, not in timeline
                  return null;
                })}
              </div>
              <div className="sticky bottom-0 bg-pure-white z-10 pb-4 md:pb-6 px-4 md:px-6">
                {activeTimelineItems
                  .filter((item) => item.type !== 'message' && item.type !== 'tool_call' && item.data.status === "pending")
                  .map((item) => {
                    const permReq = item.data as import('./lib/backend/types').PendingPermissionRequest;
                    return (
                    <div key={item.key} className="mb-4 flex w-full justify-center">
                      <div className="w-full">
                        <PermissionDisplay
                          request={permReq}
                          toolCall={
                            (activeTimeline?.tool_calls ?? []).find(
                              (toolCall) => toolCall.tool_call_id === permReq.tool_call_id,
                            ) ?? null
                          }
                          requestMeta={
                            permissionRequestMeta.get(permReq.id)
                            ?? permissionRequestMeta.get(permReq.tool_call_id)
                            ?? null
                          }
                          decision={getLatestPermissionDecision(permReq.tool_call_id, permissionDecisions)}
                        />
                      </div>
                    </div>
                    );
                  })}
                <div className="relative">
                  {showScrollButton && (
                    <div className="pointer-events-none absolute left-1/2 bottom-full z-20 mb-3 -translate-x-1/2">
                      <button
                        type="button"
                        onClick={scrollToBottom}
                        className="pointer-events-auto p-2 rounded-full bg-pure-white border border-light-gray text-stone hover:text-pure-black hover:bg-light-gray shadow-sm transition-colors cursor-pointer"
                        title="Scroll to bottom"
                        aria-label="Scroll to bottom"
                      >
                        <ArrowDown className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                  <Composer
                    input={input}
                    setInput={setInput}
                    attachments={attachmentStates}
                    activeAgent={activeAgent}
                    modelSelector={modelSelector}
                    selectedModelValue={selectedModelValue}
                    selectedModelLabel={selectedModelLabel}
                    onModelChange={(value) => void handleModelChange(String(value))}
                    isSettingModel={isSettingModel}
                    activeModeState={activeModeState}
                    selectedModeValue={selectedModeValue}
                    selectedModeLabel={selectedModeLabel}
                    onModeChange={(value) => void handleModeChange(String(value))}
                    isSettingMode={isSettingMode}
                    onAttachClick={() => fileInputRef.current?.click()}
                    onDrop={handleDrop}
                    onPaste={handlePaste}
                    onRemoveAttachment={removeAttachment}
                    onSend={() => void handleSend()}
                    onKeyDown={handleKeyDown}
                    canSend={canSend}
                    isCompact
                    isBusy={isBusy}
                    onStop={() => void handleStop()}
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {activeConversationId !== null && (
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
        />
      )}

      {isSettingsOpen && (
        <div className="fixed inset-0 bg-pure-black/10 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0" onClick={() => setIsSettingsOpen(false)} />
          <div className="w-full max-w-4xl h-[640px] bg-pure-white rounded-container border border-light-gray z-10 flex flex-col overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="flex-1 flex overflow-hidden">
              <aside className="w-[200px] bg-snow flex flex-col p-4 border-r border-light-gray/50">
                <div className="mb-4 px-2 font-display text-[14px] font-medium tracking-tight flex items-center gap-2">
                  <Settings className="w-3.5 h-3.5" />
                  <span>Settings</span>
                </div>
                <nav className="space-y-0.5 flex-1">
                    <button
                      onClick={() => setSettingsTab('general')}
                      className={`w-full text-left px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                        settingsTab === 'general' ? 'bg-light-gray/60 text-pure-black' : 'text-stone hover:bg-light-gray/30'
                      }`}
                    >
                      General
                    </button>
                    <button
                      onClick={() => setSettingsTab('agents')}
                      className={`w-full text-left px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                        settingsTab === 'agents' ? 'bg-light-gray/60 text-pure-black' : 'text-stone hover:bg-light-gray/30'
                      }`}
                    >
                      Agents
                    </button>
                    <button
                      onClick={() => setSettingsTab('mcp')}
                      className={`w-full text-left px-3 py-1.5 rounded-md text-[12px] transition-colors ${
                        settingsTab === 'mcp' ? 'bg-light-gray/60 text-pure-black' : 'text-stone hover:bg-light-gray/30'
                      }`}
                    >
                      MCP
                    </button>
                  </nav>
                <div className="mt-4 pt-4 border-t border-light-gray/50">
                  <button
                    onClick={() => setIsSettingsOpen(false)}
                    className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-[12px] font-medium text-stone hover:bg-light-gray/30 transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>关闭</span>
                  </button>
                </div>
              </aside>

              <div className="flex-1 flex flex-col min-w-0 bg-pure-white relative">
                <div className="flex-1 overflow-y-auto p-6">
                  {settingsTab === 'general' && (
                    <div className="space-y-6">
                      <section>
                        <div className="flex items-center justify-between mb-3 px-1">
                          <div className="text-[10px] text-silver font-medium uppercase tracking-wider">Display</div>
                        </div>

                        <div className="border border-light-gray/60 rounded-container overflow-hidden bg-pure-white">
                          <div className="flex items-center justify-between py-3 px-4">
                            <div className="flex flex-col gap-0.5">
                              <span className="font-display font-medium text-[13px] text-pure-black">
                                始终展示模型思考内容
                              </span>
                              <span className="text-[11px] text-stone">
                                开启后，所有思考块默认展开显示，包括已完成的对话
                              </span>
                            </div>
                            <button
                              onClick={() => setAlwaysExpandThinking(!alwaysExpandThinking)}
                              className={`relative w-12 h-7 rounded-full transition-colors border ${
                                alwaysExpandThinking
                                  ? 'bg-pure-black border-pure-black'
                                  : 'bg-pure-white border-light-gray'
                              }`}
                            >
                              <div
                                className={`absolute top-[1px] w-6 h-6 rounded-full transition-transform ${
                                  alwaysExpandThinking ? 'left-[22px] bg-pure-white' : 'left-[2px] bg-light-gray'
                                }`}
                              />
                            </button>
                          </div>
                        </div>
                      </section>
                    </div>
                  )}

                  {settingsTab === 'agents' && (
                    <div className="space-y-8">
                      <section>
                      <div className="flex items-center justify-between mb-3 px-1">
                        <div className="text-[10px] text-silver font-medium uppercase tracking-wider">Agents</div>
                      </div>
                      
                      <div className="border border-light-gray/60 rounded-container overflow-hidden bg-pure-white">
                        {sortedDiscoveryStatus.map((agent, index) => (
                          <div 
                            key={agent.command} 
                            className={`group relative flex items-center justify-between py-3 px-4 transition-colors hover:bg-snow ${
                              index !== sortedDiscoveryStatus.length - 1 ? 'border-b border-light-gray/30' : ''
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              <div className={`w-8 h-8 rounded-md flex items-center justify-center border border-light-gray/50 transition-colors p-1.5 ${
                                agent.availability !== "unavailable" ? 'bg-pure-white' : 'bg-snow opacity-50'
                              }`}>
                                <AgentLogo agent={agent} className="w-full h-full object-contain" />
                              </div>
                              <div className="flex items-baseline gap-2 min-w-0">
                                <span className="font-display font-medium text-[13px] text-pure-black leading-tight shrink-0">
                                  {agent.name}
                                </span>
                                <span className="font-mono text-[10px] text-silver truncate">
                                  {agent.command}
                                </span>
                              </div>
                            </div>
                            
                            <div className="flex items-center gap-3">
                              <span className={`flex items-center gap-1 px-2 py-0.5 rounded-pill text-[9px] font-medium uppercase tracking-wide ${
                                agent.availability === 'ready'
                                  ? 'bg-light-gray/40 text-near-black'
                                  : agent.availability === 'degraded'
                                    ? 'border border-light-gray/40 text-stone'
                                    : 'border border-light-gray/40 text-silver'
                              }`}>
                                <div className={`w-1.5 h-1.5 rounded-full ${
                                  agent.availability === 'ready'
                                    ? 'bg-[#10b981]'
                                    : agent.availability === 'degraded'
                                      ? 'bg-[#f59e0b]'
                                      : 'bg-[#9ca3af]'
                                }`} />
                                {agent.availability}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>

                    <section className="px-1 space-y-2">
                      {sortedDiscoveryStatus
                        .filter((agent) => agent.detail && agent.availability !== 'degraded')
                        .map((agent) => (
                          <div key={`${agent.command}-detail`} className="flex gap-3 p-3 rounded-container bg-snow border border-light-gray/20">
                            <AlertCircle className="w-3.5 h-3.5 text-stone shrink-0 mt-0.5" />
                            <p className="text-[11px] text-stone leading-relaxed">
                              <span className="font-medium text-pure-black">{agent.name}:</span> {agent.detail}
                            </p>
                          </div>
                        ))}
                    </section>

                    {availableAgents.length > 0 && (
                      <section className="px-1">
                        <div className="flex gap-3 p-3 rounded-container bg-snow border border-light-gray/20">
                          <AlertCircle className="w-3.5 h-3.5 text-stone shrink-0 mt-0.5" />
                          <p className="text-[11px] text-stone leading-relaxed">
                            Native ACP agents are detected from your system <code className="text-pure-black font-medium">PATH</code>. Claude Code is exposed through a bundled or system bridge runtime.
                          </p>
                        </div>
                      </section>
                    )}
                    </div>
                  )}

                  {settingsTab === 'mcp' && (
                    <div className="space-y-6">
                      <section>
                        <div className="flex gap-3 p-3 rounded-container bg-snow border border-light-gray/20">
                          <AlertCircle className="w-3.5 h-3.5 text-stone shrink-0 mt-0.5" />
                          <p className="text-[11px] text-stone leading-relaxed">
                            MCP server configuration will be available in a future update.
                          </p>
                        </div>
                      </section>
                    </div>
                  )}
                </div>
                {showScrollButton && (
              <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center px-4 md:px-6">
                <button
                  type="button"
                  onClick={scrollToBottom}
                  className="pointer-events-auto p-2 rounded-full bg-pure-white border border-light-gray text-stone hover:text-pure-black hover:bg-light-gray shadow-sm transition-colors cursor-pointer"
                  title="Scroll to bottom"
                  aria-label="Scroll to bottom"
                >
                  <ArrowDown className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )}

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
