import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,

  ChevronRight,
  Code,
  Copy,
  Cpu,
  Folder,
  FolderOpen,
  Loader2,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
  Square,
  SquarePen,
  Search,
  Settings,
  Terminal,
  ToggleLeft,
  Trash2,
  X,
} from "lucide-react";
import { Streamdown } from "streamdown";
import { motion, AnimatePresence } from "framer-motion";
import { useAppStore } from "./lib/store";
import * as API from "./lib/backend/commands";
import type * as Types from "./lib/backend/types";
import { ThoughtDisplay } from "./components/chat/ThoughtDisplay";
import { ToolCallDisplay } from "./components/chat/ToolCallDisplay";
import { TerminalDisplay } from "./components/chat/TerminalDisplay";
import { PermissionDisplay } from "./components/chat/PermissionDisplay";
import { WorkspaceDropdown } from "./components/ui/WorkspaceDropdown";

const MAX_EMBEDDED_TEXT_BYTES = 128 * 1024;
const MAX_EMBEDDED_MEDIA_BYTES = 10 * 1024 * 1024;

type LocalAttachment = {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  kind: Types.AttachmentInput["kind"];
  size: number;
  source: "picker" | "drag" | "paste";
  previewUrl?: string;
};

type AttachmentResolution = {
  canSend: boolean;
  mode: "image" | "audio" | "resource" | "resource_link" | "blocked" | "probing";
  label: string;
  reason?: string;
  deliveryPreference: Types.AttachmentInput["delivery_preference"];
};

type ModelChoice = {
  value: string;
  label: string;
};

type ModelSelectorState = {
  option: Types.SessionConfigOption;
  choices: ModelChoice[];
  selectedValue: string | null;
  selectedLabel: string | null;
};

const MODEL_CONFIG_CACHE_KEY = "oneagent.model-config-cache.v1";
const MODEL_MODELS_CACHE_KEY = "oneagent.model-metadata-cache.v1";
const MODEL_SELECTION_CACHE_KEY = "oneagent.model-selection-cache.v1";
const MODE_CACHE_KEY = "oneagent.mode-metadata-cache.v1";
const MODE_SELECTION_CACHE_KEY = "oneagent.mode-selection-cache.v1";

const markdownComponents = {
  p: ({ children }: any) => <p className="mb-1 last:mb-0">{children}</p>,
  pre: ({ children }: any) => (
    <pre className="w-full bg-snow border border-light-gray rounded-container p-3 overflow-x-auto mt-2 mb-3 min-w-0 font-mono text-small text-pure-black break-words">
      {children}
    </pre>
  ),
  code: ({ children, className, inline }: any) => {
    if (inline || !className) {
      return (
        <code className="bg-snow border border-light-gray px-1.5 py-0.5 rounded-md font-mono text-[0.9em] text-pure-black">
          {children}
        </code>
      );
    }
    return <code className="font-mono text-pure-black">{children}</code>;
  },
  ul: ({ children }: any) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }: any) => <li className="text-[14px] leading-relaxed">{children}</li>,
  h1: ({ children }: any) => <h1 className="text-xl font-display font-medium mb-2">{children}</h1>,
  h2: ({ children }: any) => <h2 className="text-lg font-display font-medium mb-1.5 mt-3">{children}</h2>,
  h3: ({ children }: any) => <h3 className="text-md font-display font-medium mb-1 mt-3">{children}</h3>,
  a: ({ children, href }: any) => (
    <a href={href} className="underline underline-offset-2 hover:text-stone transition-colors">
      {children}
    </a>
  ),
};

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

function formatProbeError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "Failed to probe agent capabilities.";
  }
  const backendError = error as Types.BackendError;
  switch (backendError.code) {
    case "runtime_not_found":
      return "Claude Code runtime not found. Bundled Bun is missing and no system bun/node fallback is available.";
    case "adapter_not_found":
      return "Claude Code adapter files are missing from the app bundle.";
    case "adapter_spawn_failed":
      return "Claude Code adapter failed to start.";
    case "claude_auth_required":
      return "Claude Code authentication is required. Configure Claude credentials and try again.";
    case "acp_initialize_failed":
      return backendError.message || "Claude Code ACP initialization failed.";
    default:
      return backendError.message || "Failed to probe agent capabilities.";
  }
}

function inferAttachmentKind(mimeType: string): Types.AttachmentInput["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

function isTextLikeMime(mimeType: string) {
  return (
    mimeType.startsWith("text/") ||
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/x-javascript",
      "application/typescript",
      "application/yaml",
      "application/x-yaml",
    ].includes(mimeType)
  );
}

function resolveAttachment(
  attachment: LocalAttachment,
  capabilities: Types.AgentCapabilities | null | undefined,
): AttachmentResolution {
  if (!capabilities?.prompt_capabilities) {
    return {
      canSend: false,
      mode: "probing",
      label: "Need capability probe",
      reason: "Probe the agent before sending attachments.",
      deliveryPreference: "auto",
    };
  }

  const prompt = capabilities.prompt_capabilities;
  if (attachment.kind === "image" && prompt.image && attachment.size <= MAX_EMBEDDED_MEDIA_BYTES) {
    return { canSend: true, mode: "image", label: "Will send as image", deliveryPreference: "embedded" };
  }
  if (attachment.kind === "audio" && prompt.audio && attachment.size <= MAX_EMBEDDED_MEDIA_BYTES) {
    return { canSend: true, mode: "audio", label: "Will send as audio", deliveryPreference: "embedded" };
  }
  if (
    attachment.kind === "file" &&
    prompt.embedded_context &&
    isTextLikeMime(attachment.mimeType) &&
    attachment.size <= MAX_EMBEDDED_TEXT_BYTES
  ) {
    return { canSend: true, mode: "resource", label: "Will embed file contents", deliveryPreference: "embedded" };
  }
  if (prompt.resource_link) {
    return { canSend: true, mode: "resource_link", label: "Will send as file reference", deliveryPreference: "resource_link" };
  }
  return {
    canSend: false,
    mode: "blocked",
    label: "Unsupported by agent",
    reason: "This agent does not advertise a compatible attachment mode.",
    deliveryPreference: "auto",
  };
}

function humanFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function optionChoices(option: Types.SessionConfigOption) {
  if (Array.isArray(option.options)) {
    return option.options.map((item: any) => {
      if (typeof item === "object" && item !== null) {
        return {
          value: item.value ?? item.id ?? item.key ?? item.name ?? "",
          label: item.label ?? item.name ?? String(item.value ?? item.id ?? item.key ?? ""),
        };
      }
      return { value: item, label: String(item) };
    });
  }
  return [];
}

function configOptionSelectedValue(option: Types.SessionConfigOption): string | null {
  const raw = option.raw ?? {};
  const selectedValueRaw =
    option.current_value ??
    raw.currentValue ??
    raw.selectedValue ??
    raw.value ??
    null;
  return selectedValueRaw === null || selectedValueRaw === undefined || selectedValueRaw === ""
    ? null
    : String(selectedValueRaw);
}

function modelChoiceId(model: Types.AcpAvailableModel): string {
  return model.id ?? model.model_id ?? "";
}

function modeDisplayLabel(mode: Pick<Types.AcpSessionMode, "id" | "name">): string {
  return mode.name?.trim() || mode.id?.trim() || "Mode";
}

function buildModelSelectorState(
  configOptions: Types.SessionConfigOption[],
  models?: Types.AcpSessionModels | null
): ModelSelectorState | null {
  // Prefer configOptions (stable API)
  const modelOption = configOptions.find((option) => {
    const category = option.category?.toLowerCase() ?? "";
    return category === "model" || option.id.toLowerCase().includes("model");
  });

  if (modelOption && modelOption.options && Array.isArray(modelOption.options) && modelOption.options.length > 0) {
    const choices = optionChoices(modelOption)
      .map((choice) => ({
        value: String(choice.value),
        label: String(choice.label || choice.value),
      }))
      .filter((choice, index, array) => array.findIndex((item) => item.value === choice.value) === index);

    const configSelectedValue = configOptionSelectedValue(modelOption);
    const modelSelectedValue = models?.current_model_id ? String(models.current_model_id) : null;
    const selectedValue =
      modelSelectedValue && choices.some((choice) => choice.value === modelSelectedValue)
        ? modelSelectedValue
        : configSelectedValue;
    const selectedLabel =
      choices.find((choice) => choice.value === selectedValue)?.label ??
      (selectedValue
        ? models?.available_models?.find((model) => modelChoiceId(model) === selectedValue)?.name ??
          String((modelOption.raw ?? {}).currentLabel ?? (modelOption.raw ?? {}).selectedLabel ?? selectedValue)
        : null);

    return {
      option: modelOption,
      choices,
      selectedValue,
      selectedLabel,
    };
  }

  // Fall back to models (unstable API)
  if (models && models.available_models && models.available_models.length > 0) {
    const choices = models.available_models
      .map((model) => ({
        value: model.id ?? model.model_id ?? "",
        label: model.name ?? model.id ?? model.model_id ?? "",
      }))
      .filter((choice) => choice.value !== "");

    const currentModelId = models.current_model_id ?? null;
    const selectedLabel = choices.find((c) => c.value === currentModelId)?.label ?? currentModelId;

    return {
      option: {
        id: "model",
        name: "Model",
        option_type: "select",
        current_value: currentModelId,
        options: [],
        raw: {},
      },
      choices,
      selectedValue: currentModelId,
      selectedLabel,
    };
  }

  return null;
}

function readJsonStorage<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJsonStorage<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore cache persistence failures.
  }
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

async function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.split(",")[1] ?? "");
    };
    reader.readAsDataURL(file);
  });
}

async function materializeAttachment(file: File, source: LocalAttachment["source"]): Promise<LocalAttachment> {
  let path = ((file as any).path as string | undefined) ?? "";
  if (!path) {
    const base64 = await readFileAsBase64(file);
    const persisted = await API.persistAttachmentBlob({
      name: file.name,
      mime_type: file.type || null,
      base64_data: base64,
    });
    path = persisted.path;
  }
  const mimeType = file.type || "application/octet-stream";
  return {
    id: crypto.randomUUID(),
    name: file.name,
    path,
    mimeType,
    kind: inferAttachmentKind(mimeType),
    size: file.size,
    source,
    previewUrl: mimeType.startsWith("image/") ? URL.createObjectURL(file) : undefined,
  };
}

export default function App() {
  const [isMobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isDesktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [isAddingAttachment, setIsAddingAttachment] = useState(false);
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [pendingDeleteConversationId, setPendingDeleteConversationId] = useState<string | null>(null);
  const [pendingModelValue, setPendingModelValue] = useState<string | null>(null);
  const [isSettingModel, setIsSettingModel] = useState(false);
  const [draftConfigOptions, setDraftConfigOptions] = useState<Types.SessionConfigOption[]>([]);
  const [draftModels, setDraftModels] = useState<Types.AcpSessionModels | null>(null);
  const [draftModes, setDraftModes] = useState<Types.AcpSessionModeState | null>(null);
  const [pendingModeValue, setPendingModeValue] = useState<string | null>(null);
  const [isSettingMode, setIsSettingMode] = useState(false);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());
  const [permissionDecisions, setPermissionDecisions] = useState<Types.PermissionDecision[]>([]);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Types.Conversation[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const scrollContentRef = useRef<HTMLDivElement | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const userHasScrolledUpRef = useRef(false);
  const isProgrammaticScrollingRef = useRef(false);
  const scrollResetTimeoutRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);

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
    selectConversation,
    setActiveAgentProfile,
    ensureAgentCapabilities,
    sendMessage,
    deleteConversation,
    setSessionConfig,
    setMode,
    cancelTurn,
    switchWorkspace,
    pickWorkspace,
  } = useAppStore();

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

  // Check if scroll is near bottom (within threshold)
  const checkIsAtBottom = () => {
    if (scrollAreaRef.current) {
      const scrollContainer = scrollAreaRef.current;
      const maxScrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      // Consider at bottom if within 50px of the maximum scroll position
      return maxScrollTop - scrollContainer.scrollTop <= 50;
    }
    return true;
  };

  // Handle scroll events to detect user manual scrolling
  const handleScrollEvent = () => {
    // Ignore scroll events triggered by programmatic scrolling
    if (isProgrammaticScrollingRef.current) {
      return;
    }

    const isAtBottom = checkIsAtBottom();
    setShowScrollButton(!isAtBottom);

    if (isAtBottom) {
      userHasScrolledUpRef.current = false;
    } else {
      // User has scrolled up away from bottom
      userHasScrolledUpRef.current = true;
    }
  };

  const clearProgrammaticScrollReset = () => {
    if (scrollResetTimeoutRef.current !== null) {
      window.clearTimeout(scrollResetTimeoutRef.current);
      scrollResetTimeoutRef.current = null;
    }
  };

  const scheduleProgrammaticScrollReset = (delayMs: number) => {
    clearProgrammaticScrollReset();
    scrollResetTimeoutRef.current = window.setTimeout(() => {
      isProgrammaticScrollingRef.current = false;
      scrollResetTimeoutRef.current = null;
      handleScrollEvent();
    }, delayMs);
  };

  const performScrollToBottom = (behavior: ScrollBehavior = "auto") => {
    const scrollContainer = scrollAreaRef.current;
    if (!scrollContainer) return;

    if (scrollRafRef.current !== null) {
      window.cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }

    isProgrammaticScrollingRef.current = true;
    scrollContainer.scrollTo({
      top: scrollContainer.scrollHeight,
      behavior,
    });
    userHasScrolledUpRef.current = false;
    setShowScrollButton(false);

    const finalize = () => {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scheduleProgrammaticScrollReset(behavior === "smooth" ? 300 : 80);
    };

    if (typeof window !== "undefined" && "requestAnimationFrame" in window) {
      scrollRafRef.current = window.requestAnimationFrame(() => {
        scrollRafRef.current = window.requestAnimationFrame(() => {
          scrollRafRef.current = null;
          finalize();
        });
      });
    } else {
      finalize();
    }
  };

  // Scroll to bottom function
  const scrollToBottom = () => {
    performScrollToBottom("smooth");
  };

  // Set up scroll listener when ref is available
  const setScrollAreaRef = (element: HTMLDivElement | null) => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.removeEventListener('scroll', handleScrollEvent);
    }
    scrollAreaRef.current = element;
    if (element) {
      element.addEventListener('scroll', handleScrollEvent);
    }
  };

  // Cleanup scroll listener on unmount
  useEffect(() => {
    return () => {
      clearProgrammaticScrollReset();
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
      if (scrollAreaRef.current) {
        scrollAreaRef.current.removeEventListener('scroll', handleScrollEvent);
      }
    };
  }, []);

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

  const activeAgent = agentProfiles.find((agent) => agent.id === activeAgentProfileId) ?? null;
  const activeDiscoveryStatus =
    agentDiscoveryStatus.find((status) => status.profile_id === activeAgentProfileId)
    ?? agentDiscoveryStatus.find((status) => status.command === activeAgent?.command);
  const activeCapabilities = activeAgent?.capabilities_cache ?? null;
  const availableAgents = agentDiscoveryStatus.filter((agent) => agent.installed);
  const conversationModelSelector = useMemo(
    () => buildModelSelectorState(
      activeConversationState?.config_options ?? [],
      activeConversationState?.models
    ),
    [activeConversationState?.config_options, activeConversationState?.models],
  );
  const draftModelSelector = useMemo(
    () => buildModelSelectorState(draftConfigOptions, draftModels),
    [draftConfigOptions, draftModels]
  );
  const modelSelector = activeConversationId ? conversationModelSelector : draftModelSelector;
  const attachmentStates = attachments.map((attachment) => ({
    attachment,
    resolution: resolveAttachment(attachment, activeCapabilities),
  }));
  const blockedAttachment = attachmentStates.find((entry) => !entry.resolution.canSend);
  const canSend = input.trim().length > 0 && !!activeAgentProfileId && !blockedAttachment && !isAddingAttachment;
  const isWorkspaceLocked = activeConversationId !== null;
  const currentConversation =
    activeConversationState?.conversation ??  // 优先使用实时轮询的状态
    conversations.find((conversation) => conversation.id === activeConversationId) ??  // 其次使用列表缓存
    null;
  const conversationStatus = statusMeta(activeConversationState?.runtime, currentConversation?.status);
  const isBusy = isSending || (conversationStatus?.pulse ?? false);

  // Calculate the last agent text message ID for each turn (for copy functionality)
  const lastAgentMessageIdsPerTurn = useMemo(() => {
    const turnLastAgentMessages = new Map<string, string>();
    
    // Group messages by turn_id and find the last agent text message in each turn
    activeTimelineItems
      .filter((item) => item.type === 'message')
      .forEach((item) => {
        const msg = item.data as Types.MessageProjection;
        if (msg.role === 'agent' && msg.kind === 'text' && msg.turn_id) {
          // Update the last agent message for this turn (will be the last one after iteration)
          turnLastAgentMessages.set(msg.turn_id, msg.id);
        }
      });
    
    return turnLastAgentMessages;
  }, [activeTimelineItems]);

  // Auto-scroll to bottom on message updates
  useEffect(() => {
    if (!scrollAreaRef.current) return;

    // When agent is busy (streaming), always scroll to bottom instantly
    if (isBusy) {
      performScrollToBottom("auto");
      return;
    }

    // When not busy, scroll to bottom only if user hasn't manually scrolled up
    if (!userHasScrolledUpRef.current) {
      performScrollToBottom("smooth");
    }
  }, [activeTimeline?.messages, isBusy]);

  useEffect(() => {
    const content = scrollContentRef.current;
    if (!content) return;

    const shouldStickToBottom = () => isBusy || !userHasScrolledUpRef.current;
    const syncToBottom = () => {
      if (!shouldStickToBottom()) return;
      performScrollToBottom(isBusy ? "auto" : "smooth");
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
  }, [isBusy, activeConversationId]);

  useEffect(() => {
    userHasScrolledUpRef.current = false;
    setShowScrollButton(false);
    performScrollToBottom("auto");
  }, [activeConversationId]);

  useEffect(() => {
    if (activeConversationId || !activeAgentProfileId) return;
    setComposerNotice(formatDiscoveryNotice(activeDiscoveryStatus));
  }, [activeConversationId, activeAgentProfileId, activeDiscoveryStatus]);

  useEffect(() => {
    if (activeConversationId || !activeWorkspace || !activeAgentProfileId) return;

    const cachedConfig =
      readJsonStorage<Record<string, Types.SessionConfigOption[]>>(MODEL_CONFIG_CACHE_KEY)?.[activeAgentProfileId] ?? [];
    const cachedModels =
      readJsonStorage<Record<string, Types.AcpSessionModels | null>>(MODEL_MODELS_CACHE_KEY)?.[activeAgentProfileId] ?? null;
    const cachedModes =
      readJsonStorage<Record<string, Types.AcpSessionModeState | null>>(MODE_CACHE_KEY)?.[activeAgentProfileId] ?? null;
    setDraftConfigOptions(cachedConfig);
    setDraftModels(cachedModels);
    setDraftModes(cachedModes);

    let cancelled = false;
    void API.previewSessionConfig({
      workspace_id: activeWorkspace.id,
      agent_profile_id: activeAgentProfileId,
    })
      .then((result) => {
        if (cancelled) return;
        // Only update if we got actual data, otherwise keep cached values
        if (result.config_options.length > 0 || result.models?.available_models?.length || result.modes?.available_modes?.length) {
          setDraftConfigOptions(result.config_options);
          setDraftModels(result.models ?? null);
          setDraftModes(result.modes ?? null);
          const nextConfigCache = {
            ...(readJsonStorage<Record<string, Types.SessionConfigOption[]>>(MODEL_CONFIG_CACHE_KEY) ?? {}),
            [activeAgentProfileId]: result.config_options,
          };
          const nextModelsCache = {
            ...(readJsonStorage<Record<string, Types.AcpSessionModels | null>>(MODEL_MODELS_CACHE_KEY) ?? {}),
            [activeAgentProfileId]: result.models ?? null,
          };
          const nextModesCache = {
            ...(readJsonStorage<Record<string, Types.AcpSessionModeState | null>>(MODE_CACHE_KEY) ?? {}),
            [activeAgentProfileId]: result.modes ?? null,
          };
          writeJsonStorage(MODEL_CONFIG_CACHE_KEY, nextConfigCache);
          writeJsonStorage(MODEL_MODELS_CACHE_KEY, nextModelsCache);
          writeJsonStorage(MODE_CACHE_KEY, nextModesCache);
        }
      })
      .catch((error) => {
        console.error("Failed to preview session config", error);
        if (!cancelled) {
          setComposerNotice(formatProbeError(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeConversationId, activeWorkspace, activeAgentProfileId]);

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

  const resetComposer = (items: LocalAttachment[] = attachments) => {
    items.forEach((attachment) => {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    });
    setAttachments([]);
    setInput("");
    setComposerNotice(null);
  };

  const handleSend = async () => {
    if (!canSend || !activeAgentProfileId || isBusy) return;
    setIsSending(true);
    const draftAttachments = attachments;
    const payload: Types.AttachmentInput[] = attachmentStates.map(({ attachment, resolution }) => ({
      id: attachment.id,
      name: attachment.name,
      path: attachment.path,
      mime_type: attachment.mimeType,
      kind: attachment.kind,
      delivery_preference: resolution.deliveryPreference,
    }));
    const text = input.trim();
    const sessionConfigOverrides: Array<{ config_id: string; value: any }> = [];
    if (!activeConversationId) {
      if (modelSelector && selectedModelValue && selectedModelValue !== modelSelector.selectedValue) {
        sessionConfigOverrides.push({ config_id: modelSelector.option.id, value: selectedModelValue });
      }
      if (activeModeState && selectedModeValue && selectedModeValue !== activeModeState.current_mode_id) {
        sessionConfigOverrides.push({ config_id: "__mode_override__", value: selectedModeValue });
      }
    }
    setAttachments([]);
    setInput("");
    setComposerNotice(null);
    try {
      await sendMessage(text, payload, sessionConfigOverrides);
      draftAttachments.forEach((attachment) => {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      });
    } catch (error) {
      console.error("Failed to send message", error);
      setInput(text);
      setAttachments(draftAttachments);
      setComposerNotice("Failed to send message.");
    } finally {
      setIsSending(false);
    }
  };

  const handleStop = async () => {
    await cancelTurn();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const addFiles = async (files: FileList | File[], source: LocalAttachment["source"]) => {
    if (!activeAgentProfileId) {
      setComposerNotice("Select an agent before adding attachments.");
      return;
    }
    setIsAddingAttachment(true);
    try {
      const capabilities = await ensureAgentCapabilities(activeAgentProfileId);
      if (!capabilities?.prompt_capabilities) {
        setComposerNotice(formatDiscoveryNotice(activeDiscoveryStatus) ?? "This agent has not returned ACP prompt capabilities yet.");
        return;
      }
      const next = await Promise.all(Array.from(files).map((file) => materializeAttachment(file, source)));
      setAttachments((current) => [...current, ...next]);
      setComposerNotice(null);
    } catch (error) {
      console.error("Failed to add attachments", error);
      setComposerNotice("Failed to process one or more attachments.");
    } finally {
      setIsAddingAttachment(false);
    }
  };

  const handleFileInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) {
      await addFiles(event.target.files, "picker");
    }
    event.target.value = "";
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer.files?.length) {
      await addFiles(event.dataTransfer.files, "drag");
    }
  };

  const handlePaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length > 0) {
      event.preventDefault();
      await addFiles(files, "paste");
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.id === id);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  };

  const draftSelections =
    readJsonStorage<Record<string, { configId: string; value: string }>>(MODEL_SELECTION_CACHE_KEY) ?? {};
  const draftSelectedValue =
    !activeConversationId && activeAgentProfileId ? draftSelections[activeAgentProfileId]?.value ?? null : null;
  const normalizedDraftSelectedValue =
    draftSelectedValue && modelSelector?.choices.some((choice) => choice.value === draftSelectedValue)
      ? draftSelectedValue
      : null;
  const selectedModelValue =
    pendingModelValue ??
    (activeConversationId
      ? modelSelector?.selectedValue ?? ""
      : normalizedDraftSelectedValue ?? modelSelector?.selectedValue ?? "");
  const selectedModelLabel =
    modelSelector?.choices.find((choice) => choice.value === selectedModelValue)?.label ??
    modelSelector?.selectedLabel ??
    null;

  const handleModelChange = async (value: string) => {
    if (!modelSelector || isSettingModel || value === selectedModelValue) return;
    if (!activeConversationId) {
      if (!activeAgentProfileId) return;
      const nextSelections = {
        ...(readJsonStorage<Record<string, { configId: string; value: string }>>(MODEL_SELECTION_CACHE_KEY) ?? {}),
        [activeAgentProfileId]: {
          configId: modelSelector.option.id,
          value,
        },
      };
      writeJsonStorage(MODEL_SELECTION_CACHE_KEY, nextSelections);
      setPendingModelValue(value);
      window.setTimeout(() => setPendingModelValue(null), 0);
      return;
    }
    const previousValue = selectedModelValue ? String(selectedModelValue) : null;
    setPendingModelValue(value);
    setIsSettingModel(true);
    setComposerNotice(null);
    try {
      await setSessionConfig(modelSelector.option.id, value);
    } catch (error) {
      console.error("Failed to set model", error);
      setPendingModelValue(previousValue);
      setComposerNotice("Failed to switch model.");
    } finally {
      setIsSettingModel(false);
      setPendingModelValue(null);
    }
  };

  const activeModeState = activeConversationId ? activeConversationState?.modes : draftModes;
  const draftModeSelections =
    readJsonStorage<Record<string, { value: string }>>(MODE_SELECTION_CACHE_KEY) ?? {};
  const draftModeSelectedValue =
    !activeConversationId && activeAgentProfileId ? draftModeSelections[activeAgentProfileId]?.value ?? null : null;
  const selectedModeValue = pendingModeValue ?? (activeConversationId ? activeModeState?.current_mode_id : draftModeSelectedValue) ?? activeModeState?.current_mode_id ?? null;
  const selectedMode =
    activeModeState?.available_modes?.find((mode) => mode.id === selectedModeValue) ?? null;
  const selectedModeLabel = selectedMode ? modeDisplayLabel(selectedMode) : selectedModeValue ?? null;

  const handleModeChange = async (value: string) => {
    if (isSettingMode || value === selectedModeValue || !activeModeState) return;
    if (!activeConversationId) {
      if (!activeAgentProfileId) return;
      const nextSelections = {
        ...(readJsonStorage<Record<string, { value: string }>>(MODE_SELECTION_CACHE_KEY) ?? {}),
        [activeAgentProfileId]: { value },
      };
      writeJsonStorage(MODE_SELECTION_CACHE_KEY, nextSelections);
      setPendingModeValue(value);
      window.setTimeout(() => setPendingModeValue(null), 0);
      return;
    }
    const previousValue = selectedModeValue ? String(selectedModeValue) : null;
    setPendingModeValue(value);
    setIsSettingMode(true);
    setComposerNotice(null);
    try {
      await setMode(value);
    } catch (error) {
      console.error("Failed to set mode", error);
      setPendingModeValue(previousValue);
      setComposerNotice("Failed to switch mode.");
    } finally {
      setIsSettingMode(false);
      setPendingModeValue(null);
    }
  };

  if (isInitializing) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-pure-white text-pure-black">
        <Loader2 className="w-6 h-6 animate-spin text-stone" />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-pure-white font-body text-pure-black selection:bg-light-gray overflow-hidden">
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInput} />

      {isMobileSidebarOpen && (
        <div className="fixed inset-0 bg-pure-black/20 z-20 md:hidden transition-opacity" onClick={() => setMobileSidebarOpen(false)} />
      )}

      <aside
        className={`
          fixed md:relative inset-y-0 left-0 z-30
          bg-snow shrink-0 flex flex-col transition-all duration-300 ease-in-out
          ${isMobileSidebarOpen ? "translate-x-0 w-[260px] border-r border-light-gray" : "-translate-x-full md:translate-x-0"}
          ${isDesktopSidebarOpen ? "md:w-[260px]" : "md:w-0 md:overflow-hidden"}
        `}
      >
        <div className="w-[260px] h-full flex flex-col">
          <div className="p-3 shrink-0">
            <div className="flex items-center justify-between mb-3 px-2">
              <div className="flex items-center justify-start h-8">
                <img src="/oneagent_horizontal.svg" alt=">_One Logo" className="h-[22px] object-contain" />
              </div>
              <button
                onClick={() => setDesktopSidebarOpen(false)}
                className="hidden md:flex p-1 text-stone hover:text-pure-black rounded-md hover:bg-light-gray/50 transition-colors"
                title="Close Sidebar"
              >
                <PanelLeftClose className="w-[18px] h-[18px]" />
              </button>
              <button
                onClick={() => setMobileSidebarOpen(false)}
                className="md:hidden p-1 text-stone hover:text-pure-black rounded-md hover:bg-light-gray/50 transition-colors"
              >
                <PanelLeftClose className="w-[18px] h-[18px]" />
              </button>
            </div>

            <div className="space-y-0.5">
              <button
                onClick={() => {
                  void selectConversation(null);
                  resetComposer();
                }}
                className={`w-full text-left px-3 py-1.5 rounded-container flex items-center gap-2.5 transition-colors min-w-0 ${
                  activeConversationId === null ? "text-pure-black font-medium bg-light-gray" : "text-near-black hover:bg-light-gray/60"
                }`}
              >
                <Plus className="w-3.5 h-3.5 shrink-0" />
                <span className="text-caption truncate w-full block">New Chat</span>
              </button>
              <button
                onClick={() => setIsSearchOpen(true)}
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
                onClick={() => void pickWorkspace()}
                className="rounded-container p-1.5 text-stone transition-colors hover:bg-light-gray/60 hover:text-pure-black"
                title="Open workspace"
                aria-label="Open workspace"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 pb-4 no-scrollbar">
            {/* Workspaces Tree */}
            <div className="space-y-1">
              {workspaces.length === 0 && <div className="px-2 py-1 text-[13px] text-silver">No workspaces</div>}
              {workspaces.map((workspace) => {
                const isExpanded = expandedWorkspaces.has(workspace.id);
                const wsConversations = workspaceConversations.get(workspace.id) ?? [];
                const hasConversations = wsConversations.length > 0;

                return (
                  <div key={workspace.id} className="space-y-0.5">
                    {/* Workspace Header */}
                    <div className="group relative w-full">
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedWorkspaces((prev) => {
                            const next = new Set(prev);
                            if (next.has(workspace.id)) {
                              next.delete(workspace.id);
                            } else {
                              next.add(workspace.id);
                            }
                            return next;
                          });
                        }}
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
                          void switchWorkspace(workspace).then(() => {
                            void selectConversation(null);
                            resetComposer();
                            setPendingDeleteConversationId(null);
                          });
                        }}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-container p-1.5 text-stone opacity-0 transition-all hover:bg-light-gray/60 hover:text-pure-black focus:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
                        title={`New chat in ${getWorkspaceLabel(workspace)}`}
                        aria-label={`New chat in ${getWorkspaceLabel(workspace)}`}
                      >
                        <SquarePen className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {/* Workspace Conversations */}
                    {isExpanded && (
                      <div className="ml-5 pl-2 border-l border-light-gray/50 space-y-0.5 mt-0.5">
                        {hasConversations ? (
                          wsConversations.map((conversation) => {
                            const agent = agentProfiles.find((a) => a.id === conversation.agent_profile_id);
                            return (
                              <SidebarItem
                                key={conversation.id}
                                title={conversation.title || "Untitled Chat"}
                                agentCommand={agent?.command ?? conversation.agent_profile_id}
                                active={activeConversationId === conversation.id}
                                onClick={() => {
                                  void selectConversation(conversation.id);
                                  setComposerNotice(null);
                                  setPendingDeleteConversationId(null);
                                }}
                                deletePending={pendingDeleteConversationId === conversation.id}
                                onDelete={() => {
                                  if (pendingDeleteConversationId === conversation.id) {
                                    setPendingDeleteConversationId(null);
                                    void deleteConversation(conversation.id);
                                    return;
                                  }
                                  setPendingDeleteConversationId(conversation.id);
                                }}
                                onCancelDelete={() => {
                                  setPendingDeleteConversationId((current) =>
                                    current === conversation.id ? null : current
                                  );
                                }}
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
              })}

            </div>
          </div>

          <div className="p-3 shrink-0">
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-small rounded-container hover:bg-snow transition-colors text-near-black text-left"
            >
              <Settings className="w-3.5 h-3.5 shrink-0" />
              Settings
            </button>
          </div>
        </div>
      </aside>

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
            <button className="p-2 shrink-0 text-stone hover:text-pure-black rounded-md hover:bg-snow transition-colors">
              <MoreHorizontal className="w-5 h-5" />
            </button>
          )}
        </header>

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
                    composerNotice={composerNotice}
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
              {/* Spacer to match scrollbar width for perfect centering */}
              <div className="w-0 overflow-y-hidden [scrollbar-gutter:stable] pointer-events-none" aria-hidden="true" />
            </div>
          </div>
        ) : (
          <div 
            ref={setScrollAreaRef}
            className="relative flex-1 overflow-y-auto min-w-0 w-full flex flex-col scroll-smooth [scrollbar-gutter:stable]"
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
                      />
                    );
                  }

                  if (item.data.status === "pending") return null;

                  return (
                    <PermissionDisplay
                      key={item.key}
                      request={item.data}
                      toolCall={
                        (activeTimeline?.tool_calls ?? []).find(
                          (toolCall) => toolCall.tool_call_id === item.data.tool_call_id,
                        ) ?? null
                      }
                      requestMeta={
                        permissionRequestMeta.get(item.data.id)
                        ?? permissionRequestMeta.get(item.data.tool_call_id)
                        ?? null
                      }
                      decision={
                        permissionDecisions
                          .filter((record) => record.tool_call_id === item.data.tool_call_id)
                          .sort((a, b) => compareIsoTimestamp(a.created_at, b.created_at))
                          .at(-1) ?? null
                      }
                    />
                  );
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
                          decision={
                            permissionDecisions
                              .filter((record) => record.tool_call_id === permReq.tool_call_id)
                              .sort((a, b) => compareIsoTimestamp(a.created_at, b.created_at))
                              .at(-1) ?? null
                          }
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
                    composerNotice={composerNotice}
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
                <nav className="space-y-0.5">
                  <button className="w-full text-left px-3 py-1.5 rounded-md bg-light-gray/60 text-pure-black text-[12px] font-medium transition-colors">
                    Agents
                  </button>
                  <button className="w-full text-left px-3 py-1.5 rounded-md text-stone hover:bg-light-gray/30 text-[12px] transition-colors">
                    MCP
                  </button>
                </nav>
              </aside>

              <div className="flex-1 flex flex-col min-w-0 bg-pure-white relative">
                <header className="h-12 flex items-center justify-between px-6 shrink-0 border-b border-light-gray/30">
                  <h2 className="font-display font-medium text-[15px]">Agents</h2>
                  <button
                    onClick={() => setIsSettingsOpen(false)}
                    className="p-1 text-stone hover:text-pure-black rounded-md hover:bg-light-gray/50 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </header>

                <div className="flex-1 overflow-y-auto p-6">
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
            onClose={() => {
              setIsSearchOpen(false);
              setSearchQuery("");
              setSearchResults([]);
            }}
            onSelect={(id) => {
              void selectConversation(id);
              setIsSearchOpen(false);
              setSearchQuery("");
              setSearchResults([]);
            }}
            workspaceId={activeWorkspace?.id ?? ""}
            setResults={setSearchResults}
            setIsSearching={setIsSearching}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function Composer({
  input,
  setInput,
  attachments,
  composerNotice,
  activeAgent,
  modelSelector,
  selectedModelValue,
  selectedModelLabel,
  onModelChange,
  isSettingModel,
  activeModeState,
  selectedModeValue,
  selectedModeLabel,
  onModeChange,
  isSettingMode,
  onAttachClick,
  onDrop,
  onPaste,
  onRemoveAttachment,
  onSend,
  onKeyDown,
  canSend,
  isCompact,
  isBusy,
  onStop,
}: {
  input: string;
  setInput: (value: string) => void;
  attachments: Array<{ attachment: LocalAttachment; resolution: AttachmentResolution }>;
  composerNotice: string | null;
  activeAgent: Types.AgentProfile | null;
  modelSelector: ModelSelectorState | null;
  selectedModelValue: any;
  selectedModelLabel: string | null;
  onModelChange: (value: any) => void;
  isSettingModel: boolean;
  activeModeState?: Types.AcpSessionModeState | null;
  selectedModeValue?: any;
  selectedModeLabel?: string | null;
  onModeChange?: (value: any) => void;
  isSettingMode?: boolean;
  onAttachClick: () => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onRemoveAttachment: (id: string) => void;
  onSend: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  canSend: boolean;
  isCompact: boolean;
  isBusy: boolean;
  onStop: () => void;
}) {
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false);
  const choices = modelSelector?.choices ?? [];
  const selectedChoice = choices.find(c => String(c.value) === String(selectedModelValue));
  const modeChoices = activeModeState?.available_modes ?? [];

  return (
    <div
      onDrop={onDrop}
      onDragOver={(event) => event.preventDefault()}
      className="w-full relative bg-pure-white border border-light-gray rounded-container transition-all flex flex-col group"
    >
      {attachments.length > 0 && (
        <div className="px-3 pt-3 space-y-2">
          {attachments.map(({ attachment, resolution }) => (
            <div key={attachment.id} className="flex items-center gap-3 rounded-xl border border-light-gray bg-snow px-3 py-2">
              {attachment.previewUrl ? (
                <img src={attachment.previewUrl} alt={attachment.name} className="w-12 h-12 rounded-lg object-cover shrink-0" />
              ) : (
                <div className="w-12 h-12 rounded-lg bg-pure-white border border-light-gray shrink-0 flex items-center justify-center">
                  <Paperclip className="w-4 h-4 text-stone" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium truncate">{attachment.name}</div>
                <div className="text-[11px] text-stone flex flex-wrap gap-2">
                  <span>{humanFileSize(attachment.size)}</span>
                  <span>{resolution.label}</span>
                </div>
                {resolution.reason && <div className="text-[11px] text-stone truncate">{resolution.reason}</div>}
              </div>
              <button className="p-1.5 rounded-md hover:bg-light-gray/60 text-stone hover:text-pure-black" onClick={() => onRemoveAttachment(attachment.id)}>
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {composerNotice && (
        <div className="mx-3 mt-3 flex items-center gap-2 rounded-xl border border-light-gray bg-snow px-3 py-2 text-[12px] text-stone">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{composerNotice}</span>
        </div>
      )}

      <textarea
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={isCompact ? "Message..." : "Message Agent..."}
        className={`w-full bg-transparent ${isCompact ? "px-4 py-3 min-h-[72px] max-h-[200px]" : "p-5 min-h-[90px] max-h-[400px]"} text-caption resize-none focus:outline-none placeholder:text-silver leading-relaxed`}
        rows={isCompact ? 2 : 3}
      />

      <div className={`flex items-center justify-between ${isCompact ? "px-3 py-2" : "px-4 py-3"} rounded-b-container relative`}>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            className={`${isCompact ? "p-1.5" : "p-2"} text-stone hover:text-pure-black rounded-pill hover:bg-light-gray/50 transition-colors shrink-0`}
            title="Add Attachment"
            onClick={onAttachClick}
          >
            <Paperclip className={isCompact ? "w-3.5 h-3.5" : "w-4 h-4"} />
          </button>

          <div className="relative">
            {modelSelector && modelSelector.choices.length > 0 ? (
              <>
                <button
                  onClick={() => !isSettingModel && setIsModelMenuOpen(!isModelMenuOpen)}
                  disabled={isSettingModel}
                  className={`flex items-center gap-1.25 ${isCompact ? "px-2 py-1 text-[11px]" : "px-2.5 py-1.5 text-small"} text-stone bg-transparent rounded-pill transition-colors select-none ${
                    !isSettingModel ? "hover:text-pure-black hover:bg-snow" : "opacity-60 cursor-not-allowed"
                  }`}
                >
                  {isSettingModel && <Loader2 className={isCompact ? "w-3 h-3 animate-spin" : "w-3.5 h-3.5 animate-spin"} />}
                  <span className="truncate max-w-[150px] font-medium">
                    {selectedChoice?.label || selectedModelLabel || "Select Model"}
                  </span>
                  <ChevronDown className={`${isCompact ? "w-2.5 h-2.5" : "w-3 h-3"} transition-transform ${isModelMenuOpen ? 'rotate-180' : ''}`} />
                </button>

                <AnimatePresence>
                  {isModelMenuOpen && (
                    <>
                      <div className="fixed inset-0 z-[60]" onClick={() => setIsModelMenuOpen(false)} />
                      <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: 5 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 5 }}
                        transition={{ duration: 0.15, ease: "easeOut" }}
                        className="absolute bottom-full left-0 mb-2 w-max min-w-[220px] max-w-[320px] max-h-[300px] overflow-y-auto bg-pure-white border border-light-gray rounded-container z-[70] py-1.5 flex flex-col scrollbar-thin shadow-none"
                      >
                        <div className="px-3 py-1">
                          <span className="text-[10px] font-medium text-silver uppercase tracking-wider">Models</span>
                        </div>
                        {modelSelector.choices.map((choice) => (
                          <button
                            key={String(choice.value)}
                            onClick={() => {
                              onModelChange(choice.value);
                              setIsModelMenuOpen(false);
                            }}
                            title={choice.label}
                            className={`w-full text-left px-3 py-2 text-[13px] transition-colors flex items-center justify-between gap-4 ${
                              String(choice.value) === String(selectedModelValue)
                                ? 'bg-light-gray/60 text-pure-black font-medium'
                                : 'text-near-black hover:bg-snow'
                            }`}
                          >
                            <span className="truncate">{choice.label}</span>
                            {String(choice.value) === String(selectedModelValue) && (
                              <Check className="w-3.5 h-3.5 text-pure-black shrink-0" />
                            )}
                          </button>
                        ))}
                      </motion.div>
                    </>
                  )}
                </AnimatePresence>
              </>
            ) : modelSelector ? (
              // State 2: Has model info but no choices (read-only)
              <div
                title="Model switching not available"
                className={`flex items-center gap-1.5 ${isCompact ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-small"} text-stone bg-snow border border-light-gray rounded-pill select-none`}
              >
                <Cpu className={isCompact ? "w-3 h-3" : "w-3.5 h-3.5"} />
                <span className="truncate max-w-[150px] font-medium">
                  {selectedModelLabel || "Default Model"}
                </span>
              </div>
            ) : (
              // State 3: No model info (disabled placeholder)
              <div
                title="Model info not available"
                className={`flex items-center gap-1.5 ${isCompact ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-small"} text-silver bg-snow border border-light-gray rounded-pill opacity-50 select-none`}
              >
                <Cpu className={isCompact ? "w-3 h-3" : "w-3.5 h-3.5"} />
                <span className="truncate max-w-[120px]">Default Model</span>
              </div>
            )}
          </div>

          {activeModeState && activeModeState.available_modes?.length > 0 && onModeChange && (
            <div className="relative">
              <button
                onClick={() => !isSettingMode && setIsModeMenuOpen(!isModeMenuOpen)}
                disabled={isSettingMode}
                className={`flex items-center gap-1.25 ${isCompact ? "px-2 py-1 text-[11px]" : "px-2.5 py-1.5 text-small"} text-stone bg-transparent rounded-pill transition-colors select-none ${
                  !isSettingMode ? "hover:text-pure-black hover:bg-snow" : "opacity-60 cursor-not-allowed"
                }`}
              >
                {isSettingMode && <Loader2 className={isCompact ? "w-3 h-3 animate-spin" : "w-3.5 h-3.5 animate-spin"} />}
                <span className="truncate max-w-[150px] font-medium">
                  {selectedModeLabel ?? selectedModeValue ?? "Select Mode"}
                </span>
                <ChevronDown className={`${isCompact ? "w-2.5 h-2.5" : "w-3 h-3"} transition-transform ${isModeMenuOpen ? 'rotate-180' : ''}`} />
              </button>

              <AnimatePresence>
                {isModeMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-[60]" onClick={() => setIsModeMenuOpen(false)} />
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95, y: 5 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95, y: 5 }}
                      transition={{ duration: 0.15, ease: "easeOut" }}
                      className="absolute bottom-full left-0 mb-2 w-max min-w-[220px] max-w-[320px] max-h-[300px] overflow-y-auto bg-pure-white border border-light-gray rounded-container z-[70] py-1.5 flex flex-col scrollbar-thin shadow-none"
                    >
                      <div className="px-3 py-1">
                        <span className="text-[10px] font-medium text-silver uppercase tracking-wider">Available Modes</span>
                      </div>
                      {modeChoices.map((choice: any) => (
                        <button
                          key={choice.id}
                          onClick={() => {
                            onModeChange?.(choice.id);
                            setIsModeMenuOpen(false);
                          }}
                          title={choice.description ?? choice.name}
                          className={`w-full text-left px-3 py-2 text-[13px] transition-colors flex items-center justify-between gap-4 ${
                            String(choice.id) === String(selectedModeValue)
                              ? 'bg-light-gray/60 text-pure-black font-medium'
                              : 'text-near-black hover:bg-snow'
                          }`}
                        >
                          <span className="truncate">{modeDisplayLabel(choice)}</span>
                          {String(choice.id) === String(selectedModeValue) && (
                            <Check className="w-3.5 h-3.5 text-pure-black shrink-0" />
                          )}
                        </button>
                      ))}
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>

        {isBusy ? (
          <button
            className={`${isCompact ? "p-1.5" : "p-2.5"} rounded-pill shrink-0 flex items-center justify-center bg-light-gray text-pure-black hover:bg-mid-gray transition-colors`}
            onClick={onStop}
          >
            <Square className={isCompact ? "w-3.5 h-3.5" : "w-4 h-4"} />
          </button>
        ) : (
          <button
            className={`${isCompact ? "p-1.5" : "p-2.5"} rounded-pill transition-colors shrink-0 flex items-center justify-center ${canSend ? "bg-pure-black text-pure-white" : "bg-light-gray text-silver"}`}
            disabled={!canSend}
            onClick={onSend}
          >
            <ArrowUp className={isCompact ? "w-3.5 h-3.5" : "w-4 h-4"} />
          </button>
        )}
      </div>
    </div>
  );
}

function SidebarItem({ 
  title, 
  agentCommand,
  active = false, 
  onClick,
  deletePending = false,
  onDelete,
  onCancelDelete,
}: { 
  title: string; 
  agentCommand?: string;
  active?: boolean; 
  onClick?: () => void;
  deletePending?: boolean;
  onDelete?: () => void;
  onCancelDelete?: () => void;
}) {
  return (
    <div
      className={`group w-full rounded-container flex items-center gap-1 min-w-0 border border-transparent transition-colors ${active ? "bg-light-gray" : "hover:bg-light-gray/50"}`}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex-1 text-left px-3 py-1 flex items-center gap-2.5 min-w-0 rounded-container"
      >
        <div className={`w-4 h-4 flex items-center justify-center shrink-0 ${active ? 'opacity-100' : 'opacity-40'}`}>
          {agentCommand ? <AgentLogo agent={agentCommand} className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
        </div>
        <span className={`text-small truncate flex-1 ${active ? "text-pure-black font-medium" : "text-near-black"}`}>{title}</span>
      </button>
      {onDelete && (
        deletePending ? (
          <div className="flex items-center gap-1 pr-1.5 shrink-0">
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDelete();
              }}
              className="px-2.5 py-1 rounded-container bg-pure-black text-pure-white text-[11px] font-medium hover:opacity-90 transition-opacity"
              title="Confirm delete conversation"
              aria-label={`Confirm delete conversation ${title}`}
            >
              Delete
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onCancelDelete?.();
              }}
              className="p-1 rounded-container text-stone hover:text-pure-black hover:bg-light-gray transition-colors"
              title="Cancel delete"
              aria-label={`Cancel delete conversation ${title}`}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onDelete();
            }}
            className="opacity-0 group-hover:opacity-100 p-1.5 rounded-container text-stone hover:text-pure-black hover:bg-light-gray transition-all shrink-0 cursor-pointer mr-1"
            title="Delete conversation"
            aria-label={`Delete conversation ${title}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )
      )}
    </div>
  );
}

function TimelineMessage({
  message,
  terminals,
  lastAgentMessageIdsPerTurn,
}: {
  message: Types.MessageProjection;
  terminals: Types.TerminalRecord[];
  lastAgentMessageIdsPerTurn: Map<string, string>;
}) {
  if (message.kind === "plan") {
    return <PlanMessage entries={Array.isArray(message.content_json?.entries) ? message.content_json.entries : []} />;
  }
  if (message.kind === "terminal") {
    return (
      <TerminalDisplay
        content={message.content_json?.content || ""}
        stream={message.content_json?.stream || "stdout"}
        event={message.content_json?.event || "running"}
        terminal={terminals.find((item) => item.terminal_id === message.content_json?.terminal_id) ?? null}
      />
    );
  }
  if (message.kind === "status") {
    return <StatusMessage content={message.content_json?.message || message.content_json?.text || ""} />;
  }
  if (message.kind === "error") {
    return <ErrorMessage content={message.content_json?.message || message.content_json?.text || ""} />;
  }
  // Check if this is the last agent message in its turn
  const isLastAgentInTurn = message.role === 'agent' && 
    message.kind === 'text' && 
    !!message.turn_id && 
    lastAgentMessageIdsPerTurn.get(message.turn_id) === message.id;
  return (
    <Message
      role={message.role as "user" | "agent" | "assistant" | "tool" | "system"}
      content={message.content_json?.text || message.content_json?.message || ""}
      attachments={Array.isArray(message.content_json?.attachments) ? message.content_json.attachments : []}
      kind={message.kind}
      contentJson={message.content_json}
      messageId={message.id}
      isLastAgentMessage={isLastAgentInTurn}
    />
  );
}

function Message({
  role,
  content,
  attachments,
  kind,
  contentJson,
  messageId,
  isLastAgentMessage,
}: {
  role: "user" | "agent" | "assistant" | "tool" | "system";
  content: string;
  attachments: Types.AttachmentInput[];
  kind?: string;
  contentJson?: any;
  messageId?: string;
  isLastAgentMessage?: boolean;
}) {
  const isUser = role === "user";
  const isDiff = kind === "diff";
  const [copied, setCopied] = useState(false);

  // Efficiently strip tags without unnecessary state if possible
  const displayContent = useMemo(() => {
    if (isUser || isDiff || !content) return content;
    // Strip <think> and <thinking> blocks including incomplete ones (important for streaming)
    return content
      .replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "")
      .replace(/<thinking>[\s\S]*?(?:<\/thinking>|$)/g, "")
      .trim();
  }, [content, isUser, isDiff]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(displayContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  // Determine if copy button should be shown
  const showCopyButton = isUser || isLastAgentMessage;

  if (!displayContent && !isUser && !isDiff && attachments.length === 0) return null;

  return (
    <div className={`group flex w-full ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`flex flex-col gap-1 min-w-0 w-full ${isUser ? "max-w-[95%] md:max-w-[85%] items-end" : "items-start"} mt-0.5`}>
        <div className={`text-chat leading-relaxed break-words min-w-0 w-fit max-w-full ${isUser ? "bg-light-gray px-4 py-2 rounded-container" : "text-pure-black py-2 pl-0 pr-4"}`}>
          {isUser ? (
            <div className="whitespace-pre-wrap">{displayContent}</div>
          ) : isDiff ? (
            <div className="space-y-4 w-full">
              {Array.isArray(contentJson?.diffs) && contentJson.diffs.map((diff: any, idx: number) => (
                <div key={idx} className="border border-light-gray rounded-lg overflow-hidden bg-pure-white w-full max-w-full min-w-0">
                  <div className="bg-snow px-3 py-1.5 border-b border-light-gray flex items-center gap-2">
                    <Code className="w-3.5 h-3.5 text-stone" />
                    <span className="text-[11px] font-mono font-medium text-near-black truncate">{diff.path}</span>
                  </div>
                  <pre className="p-3 text-[12px] font-mono overflow-x-auto whitespace-pre">
                    {diff.patch.split('\n').map((line: string, i: number) => {
                      const isAdded = line.startsWith('+');
                      const isRemoved = line.startsWith('-');
                      return (
                        <div key={i} className={`${isAdded ? "bg-snow text-near-black font-medium" : isRemoved ? "bg-light-gray/30 text-stone" : ""}`}>
                          {line}
                        </div>
                      );
                    })}
                  </pre>
                </div>
              ))}
            </div>
          ) : (
            <Streamdown components={markdownComponents}>{displayContent || ""}</Streamdown>
          )}
          {attachments.length > 0 && (
            <div className={`mt-3 space-y-2 ${!isUser ? "" : ""}`}>
              {attachments.map((attachment) => (
                <div key={attachment.id} className="rounded-xl border border-light-gray bg-pure-white/80 px-3 py-2 text-[12px] text-stone">
                  <div className="font-medium text-pure-black truncate">{attachment.name}</div>
                  <div className="flex gap-2 flex-wrap">
                    <span>{attachment.kind}</span>
                    <span>{attachment.delivery_preference}</span>
                    {attachment.mime_type && <span>{attachment.mime_type}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {showCopyButton && (
          <button
            type="button"
            onClick={handleCopy}
            className="opacity-0 group-hover:opacity-100 p-1 rounded-full text-stone hover:text-pure-black hover:bg-light-gray transition-all cursor-pointer"
            title="Copy message"
            aria-label={`Copy message ${messageId || ''}`}
          >
            {copied ? (
              <Check className="w-3.5 h-3.5" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function PlanMessage({
  entries,
}: {
  entries: Array<{ content?: string; text?: string; status?: string }>;
}) {
  return (
    <div className="flex w-full justify-start mt-1 mb-2">
      <div className="w-full max-w-[95%] md:max-w-[85%] border border-light-gray rounded-container bg-snow px-4 py-3">
        <div className="text-[11px] font-medium text-stone uppercase tracking-wider mb-2">Plan</div>
        <div className="space-y-2">
          {entries.length === 0 && <div className="text-[13px] text-stone">No plan details yet.</div>}
          {entries.map((entry, index) => (
            <div key={index} className="flex items-start gap-3">
              <div className="mt-1 w-1.5 h-1.5 rounded-full bg-stone shrink-0" />
              <div className="min-w-0">
                <div className="text-[14px] leading-relaxed text-pure-black whitespace-pre-wrap">
                  {entry.content || entry.text || `Step ${index + 1}`}
                </div>
                {entry.status && <div className="text-[11px] text-silver uppercase tracking-wider mt-1">{entry.status}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusMessage({ content }: { content: string }) {
  return (
    <div className="flex w-full justify-center mt-1 mb-2">
      <div className="rounded-pill border border-light-gray bg-snow px-3 py-1.5 text-[12px] text-stone">
        {content || "Status updated"}
      </div>
    </div>
  );
}

function ErrorMessage({ content }: { content: string }) {
  return (
    <div className="flex w-full justify-start mt-1 mb-2">
      <div className="w-full max-w-[95%] md:max-w-[85%] border border-light-gray bg-snow rounded-container px-4 py-3 text-near-black">
        <div className="flex items-center gap-2 mb-1 text-stone">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="text-[11px] font-medium uppercase tracking-wider">Error</span>
        </div>
        <div className="text-[14px] leading-relaxed whitespace-pre-wrap">{content || "Unknown error"}</div>
      </div>
    </div>
  );
}

function SearchOverlay({
  query,
  setQuery,
  results,
  isSearching,
  onClose,
  onSelect,
  workspaceId,
  setResults,
  setIsSearching,
}: {
  query: string;
  setQuery: (q: string) => void;
  results: Types.Conversation[];
  isSearching: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  workspaceId: string;
  setResults: (results: Types.Conversation[]) => void;
  setIsSearching: (loading: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { agentProfiles } = useAppStore();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    const timer = setTimeout(() => {
      void (async () => {
        setIsSearching(true);
        try {
          const data = await API.searchConversations({
            workspace_id: workspaceId,
            query: query,
          });
          setResults(data);
        } catch (error) {
          console.error("Search failed:", error);
        } finally {
          setIsSearching(false);
        }
      })();
    }, 300);

    return () => clearTimeout(timer);
  }, [query, workspaceId, setResults, setIsSearching]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] px-4 bg-pure-white/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: -20, opacity: 0, scale: 0.98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: -20, opacity: 0, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        className="w-full max-w-2xl bg-pure-white rounded-container border border-light-gray flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-light-gray flex items-center gap-3">
          <Search className="w-5 h-5 text-stone" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations..."
            className="flex-1 bg-transparent text-bodyLarge focus:outline-none placeholder:text-silver"
          />
          {isSearching && <Loader2 className="w-4 h-4 animate-spin text-stone" />}
          <button
            onClick={onClose}
            className="p-1 rounded-pill hover:bg-snow text-stone transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2 no-scrollbar">
          {query.trim() === "" ? (
            <div className="py-12 text-center text-stone text-caption">
              Type to search your conversations
            </div>
          ) : results.length === 0 && !isSearching ? (
            <div className="py-12 text-center text-stone text-caption">
              No conversations found for "{query}"
            </div>
          ) : (
            <div className="space-y-1">
              {results.map((result) => {
                const agent = agentProfiles.find(p => p.id === result.agent_profile_id);
                return (
                  <button
                    key={result.id}
                    onClick={() => onSelect(result.id)}
                    className="w-full group text-left px-3 py-2.5 rounded-container hover:bg-snow transition-all flex items-center gap-4"
                  >
                    <div className="w-10 h-10 rounded-container border border-light-gray bg-pure-white flex items-center justify-center shrink-0">
                      <AgentLogo agent={agent ?? result.agent_profile_id} className="w-6 h-6 object-contain" />
                    </div>
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-[15px] text-pure-black truncate">
                          {result.title || "Untitled Chat"}
                        </span>
                        {result.origin === 'worker_task' && (
                          <span className="px-2 py-0.5 rounded-pill bg-light-gray/60 text-[9px] font-medium uppercase tracking-tight text-near-black">
                            Task
                          </span>
                        )}
                      </div>
                      <div className="text-[12px] text-stone mt-0.5 flex items-center gap-2">
                        <span className="truncate max-w-[120px]">{agent?.name || "Agent"}</span>
                        <span className="text-silver opacity-50">•</span>
                        <span>
                          {new Date(result.updated_at).toLocaleString([], {
                            year: 'numeric',
                            month: 'numeric',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: false
                          })}
                        </span>
                      </div>
                    </div>

                    <ChevronRight className="w-4 h-4 text-silver opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="p-3 bg-snow border-t border-light-gray flex items-center justify-between text-[11px] text-silver">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1">
              <span className="px-1.5 py-0.5 bg-pure-white border border-light-gray rounded-md text-stone">ESC</span>
              to close
            </span>
            <span className="flex items-center gap-1">
              <span className="px-1.5 py-0.5 bg-pure-white border border-light-gray rounded-md text-stone">ENTER</span>
              to select
            </span>
          </div>
          <div>{results.length} results</div>
        </div>
      </motion.div>
    </motion.div>
  );
}
