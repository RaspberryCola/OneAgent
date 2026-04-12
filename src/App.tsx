import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUp,
  Bot,
  ChevronDown,
  Code,
  Cpu,
  Folder,
  Loader2,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
  Search,
  Settings,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { Streamdown } from "streamdown";
import { motion, AnimatePresence } from "framer-motion";
import { useAppStore } from "./lib/store";
import * as API from "./lib/backend/commands";
import type * as Types from "./lib/backend/types";

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
const MODEL_SELECTION_CACHE_KEY = "oneagent.model-selection-cache.v1";

const markdownComponents = {
  p: ({ children }: any) => <p className="mb-2 last:mb-0">{children}</p>,
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
  claude: "/src/assets/logos/ai-major/claude.svg",
  anthropic: "/src/assets/logos/ai-major/anthropic.svg",
  qwen: "/src/assets/logos/ai-china/qwen.svg",
  openai: "/src/assets/logos/ai-major/openai.svg",
  gemini: "/src/assets/logos/ai-major/gemini.svg",
  deepseek: "/src/assets/logos/ai-major/deepseek.svg",
  mistral: "/src/assets/logos/ai-major/mistral.svg",
  tencent: "/src/assets/logos/ai-china/tencent.svg",
  kimi: "/src/assets/logos/ai-china/kimi.svg",
  baidu: "/src/assets/logos/ai-china/baidu.svg",
  zhipu: "/src/assets/logos/ai-china/zhipu.svg",
  minimax: "/src/assets/logos/ai-china/minimax.png",
  volcengine: "/src/assets/logos/ai-china/volcengine.svg",
  stepfun: "/src/assets/logos/ai-china/stepfun.svg",
  lingyiwanwu: "/src/assets/logos/ai-china/lingyiwanwu.svg",
  opencode: "/src/assets/logos/tools/coding/opencode.svg",
};

function getAgentLogo(command: string) {
  const cmd = command.toLowerCase();
  for (const key in AGENT_LOGOS) {
    if (cmd.includes(key)) return AGENT_LOGOS[key];
  }
  return null;
}

function AgentLogo({ command, className = "w-4 h-4" }: { command: string; className?: string }) {
  const logo = getAgentLogo(command);
  if (logo) {
    return <img src={logo} alt={command} className={`${className} object-contain`} />;
  }
  return <Bot className={className} />;
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

function buildModelSelectorState(configOptions: Types.SessionConfigOption[]): ModelSelectorState | null {
  const modelOption = configOptions.find((option) => {
    const category = option.category?.toLowerCase() ?? "";
    return category === "model" || option.id.toLowerCase().includes("model");
  });
  if (!modelOption) return null;

  const choices = optionChoices(modelOption)
    .map((choice) => ({
      value: String(choice.value),
      label: String(choice.label || choice.value),
    }))
    .filter((choice, index, array) => array.findIndex((item) => item.value === choice.value) === index);

  const raw = modelOption.raw ?? {};
  const selectedValueRaw =
    modelOption.current_value ??
    raw.currentValue ??
    raw.selectedValue ??
    raw.value ??
    null;
  const selectedValue =
    selectedValueRaw === null || selectedValueRaw === undefined || selectedValueRaw === ""
      ? null
      : String(selectedValueRaw);
  const selectedLabel =
    choices.find((choice) => choice.value === selectedValue)?.label ??
    (selectedValue ? String(raw.currentLabel ?? raw.selectedLabel ?? selectedValue) : null);

  return {
    option: modelOption,
    choices,
    selectedValue,
    selectedLabel,
  };
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

function statusMeta(status?: Types.Conversation["status"]) {
  switch (status) {
    case "starting":
      return {
        label: "Initializing",
        dot: "bg-amber-500",
        pulse: true,
      };
    case "running":
      return {
        label: "Thinking",
        dot: "bg-blue-500",
        pulse: true,
      };
    case "ready":
    case "idle":
      return {
        label: "Connected",
        dot: "bg-emerald-500",
        pulse: false,
      };
    case "failed":
      return {
        label: "Failed",
        dot: "bg-rose-500",
        pulse: false,
      };
    case "cancelling":
      return {
        label: "Cancelling",
        dot: "bg-amber-500",
        pulse: true,
      };
    case "cancelled":
      return {
        label: "Cancelled",
        dot: "bg-stone-400",
        pulse: false,
      };
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);

  const {
    isInitializing,
    init,
    activeWorkspace,
    agentDiscoveryStatus,
    agentProfiles,
    activeAgentProfileId,
    conversations,
    activeConversationId,
    activeConversationState,
    activeTimeline,
    selectConversation,
    setActiveAgentProfile,
    ensureAgentCapabilities,
    sendMessage,
    deleteConversation,
    setSessionConfig,
  } = useAppStore();

  useEffect(() => {
    init();
  }, [init]);

  // Auto-scroll to bottom on message updates
  useEffect(() => {
    if (scrollAreaRef.current) {
      const scrollContainer = scrollAreaRef.current;
      const isAtBottom =
        scrollContainer.scrollHeight - scrollContainer.scrollTop <= scrollContainer.clientHeight + 100;
      
      if (isAtBottom) {
        scrollContainer.scrollTo({
          top: scrollContainer.scrollHeight,
          behavior: "smooth",
        });
      }
    }
  }, [activeTimeline?.messages]);

  useEffect(() => {
    return () => {
      attachments.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
    };
  }, [attachments]);

  const activeAgent = agentProfiles.find((agent) => agent.id === activeAgentProfileId) ?? null;
  const activeCapabilities = activeAgent?.capabilities_cache ?? null;
  const installedAgents = agentDiscoveryStatus.filter((agent) => agent.installed);
  const conversationModelSelector = useMemo(
    () => buildModelSelectorState(activeConversationState?.config_options ?? []),
    [activeConversationState?.config_options],
  );
  const draftModelSelector = useMemo(() => buildModelSelectorState(draftConfigOptions), [draftConfigOptions]);
  const modelSelector = activeConversationId ? conversationModelSelector : draftModelSelector;
  const attachmentStates = attachments.map((attachment) => ({
    attachment,
    resolution: resolveAttachment(attachment, activeCapabilities),
  }));
  const blockedAttachment = attachmentStates.find((entry) => !entry.resolution.canSend);
  const canSend = input.trim().length > 0 && !!activeAgentProfileId && !blockedAttachment && !isAddingAttachment;
  const currentConversation =
    conversations.find((conversation) => conversation.id === activeConversationId) ??
    activeConversationState?.conversation ??
    null;
  const conversationStatus = statusMeta(currentConversation?.status);

  useEffect(() => {
    if (activeConversationId || !activeWorkspace || !activeAgentProfileId) return;

    const cachedConfig =
      readJsonStorage<Record<string, Types.SessionConfigOption[]>>(MODEL_CONFIG_CACHE_KEY)?.[activeAgentProfileId] ?? [];
    setDraftConfigOptions(cachedConfig);

    let cancelled = false;
    void API.previewSessionConfig({
      workspace_id: activeWorkspace.id,
      agent_profile_id: activeAgentProfileId,
    })
      .then((configOptions) => {
        if (cancelled) return;
        setDraftConfigOptions(configOptions);
        const nextCache = {
          ...(readJsonStorage<Record<string, Types.SessionConfigOption[]>>(MODEL_CONFIG_CACHE_KEY) ?? {}),
          [activeAgentProfileId]: configOptions,
        };
        writeJsonStorage(MODEL_CONFIG_CACHE_KEY, nextCache);
      })
      .catch((error) => {
        console.error("Failed to preview session config", error);
      });

    return () => {
      cancelled = true;
    };
  }, [activeConversationId, activeWorkspace, activeAgentProfileId]);

  const timelineItems = useMemo(() => {
    if (!activeTimeline) return [];
    
    const items: Array<{
      type: 'message' | 'tool_call' | 'permission';
      id: string;
      timestamp: number;
      data: any;
    }> = [];

    activeTimeline.messages.forEach(m => {
        items.push({
          type: 'message',
          id: m.id,
          timestamp: 0,
          data: m
        });
      });

    activeTimeline.tool_calls.forEach(t => {
      items.push({
        type: 'tool_call',
        id: t.id,
        timestamp: 0,
        data: t
      });
    });

    activeTimeline.pending_permissions.forEach((request) => {
      items.push({
        type: 'permission',
        id: request.id,
        timestamp: 0,
        data: request,
      });
    });

    return items.sort((a, b) => {
      const aTime =
        a.type === "message" ? a.data.created_at : a.type === "tool_call" ? a.data.started_at : a.data.created_at;
      const bTime =
        b.type === "message" ? b.data.created_at : b.type === "tool_call" ? b.data.started_at : b.data.created_at;
      const timeDiff = compareIsoTimestamp(aTime, bTime);
      if (timeDiff !== 0) return timeDiff;
      
      if (a.type === 'permission' && b.type !== 'permission') return 1;
      if (a.type !== 'permission' && b.type === 'permission') return -1;
      if (a.type === 'message' && b.type === 'message') {
        if (a.data.role === "user" && b.data.role !== "user") return -1;
        if (a.data.role !== "user" && b.data.role === "user") return 1;
        if (a.data.kind === "thinking" && b.data.kind !== "thinking") return -1;
        if (a.data.kind !== "thinking" && b.data.kind === "thinking") return 1;
      }
      return 0;
    });
  }, [activeTimeline]);

  const resetComposer = (items: LocalAttachment[] = attachments) => {
    items.forEach((attachment) => {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    });
    setAttachments([]);
    setInput("");
    setComposerNotice(null);
  };

  const handleSend = async () => {
    if (!canSend || !activeAgentProfileId) return;
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
    const sessionConfigOverrides =
      !activeConversationId && modelSelector && selectedModelValue && selectedModelValue !== modelSelector.selectedValue
        ? [{ config_id: modelSelector.option.id, value: selectedModelValue }]
        : [];
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
    }
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
        setComposerNotice("This agent has not returned ACP prompt capabilities yet.");
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
                <img src="/src/assets/oneagent_horizontal.svg" alt=">_One Logo" className="h-[22px] object-contain" />
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
                className={`w-full text-left px-2 py-1.5 rounded-md flex items-center gap-2 transition-colors min-w-0 hover:bg-light-gray/50 ${
                  activeConversationId === null ? "text-pure-black font-medium bg-light-gray/30" : "text-near-black"
                }`}
              >
                <Plus className="w-3.5 h-3.5 shrink-0" />
                <span className="text-[13px] truncate w-full block">New Chat</span>
              </button>
              <button className="w-full text-left px-2 py-1.5 rounded-md flex items-center gap-2 transition-colors min-w-0 hover:bg-light-gray/50 text-near-black">
                <Search className="w-3.5 h-3.5 shrink-0" />
                <span className="text-[13px] truncate w-full block">Search</span>
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-5">
            <div>
              <div className="text-[11px] text-silver font-medium px-2 mb-1.5 uppercase tracking-wider">Conversations</div>
              <div className="space-y-0.5">
                {conversations.length === 0 && <div className="px-2 py-1 text-[13px] text-silver">No history yet</div>}
                {conversations.map((conversation) => {
                  const agent = agentProfiles.find(a => a.id === conversation.agent_profile_id);
                  return (
                    <SidebarItem
                      key={conversation.id}
                      title={conversation.title || "Untitled Chat"}
                      agentCommand={agent?.command}
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
                })}
              </div>
            </div>
          </div>

          <div className="p-3 shrink-0">
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] rounded-md hover:bg-light-gray/50 transition-colors text-pure-black text-left"
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
                    <AgentLogo command={activeAgent.command} className="w-5 h-5 object-contain" />
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
              <h1 className="text-[40px] leading-none font-display font-medium text-pure-black text-center tracking-tight">
                What can I help you build?
              </h1>
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
                          command={profile.command}
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
              {installedAgents.length === 0 && (
                <div className="text-small text-stone text-center max-w-xl">
                  No ACP-compatible agent was detected in your PATH. Install at least <span className="font-mono">qwen</span> or{" "}
                  <span className="font-mono">opencode</span> and restart OneAgent.
                </div>
              )}
            </div>
            <div className="w-full max-w-[768px] mx-auto px-4 md:px-6">
              <Composer
                input={input}
                setInput={setInput}
                attachments={attachmentStates}
                composerNotice={composerNotice}
                activeWorkspace={activeWorkspace}
                activeAgent={activeAgent}
                modelSelector={modelSelector}
                selectedModelValue={selectedModelValue}
                selectedModelLabel={selectedModelLabel}
                onModelChange={(value) => void handleModelChange(String(value))}
                isSettingModel={isSettingModel}
                onAttachClick={() => fileInputRef.current?.click()}
                onDrop={handleDrop}
                onPaste={handlePaste}
                onRemoveAttachment={removeAttachment}
                onSend={() => void handleSend()}
                onKeyDown={handleKeyDown}
                canSend={canSend}
                isCompact={false}
              />
            </div>
          </div>
        ) : (
          <>
            <div 
              ref={scrollAreaRef}
              className="flex-1 overflow-y-auto min-w-0 w-full [mask-image:linear-gradient(to_bottom,transparent,black_8px,black_calc(100%-8px),transparent)] flex flex-col scroll-smooth"
            >
              <div className="max-w-[768px] mx-auto w-full space-y-4 px-4 md:px-6 pt-4 pb-2">
                {timelineItems.map((item) => {
                  if (item.type === 'message') {
                    const message = item.data;
                    if (message.kind === "thinking") {
                      return (
                        <ThinkingMessage
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
                      />
                    );
                  } else if (item.type === 'tool_call') {
                    return (
                      <ToolCallMessage 
                        key={item.id}
                        toolCall={item.data}
                        terminals={(activeTimeline?.terminals ?? []).filter((terminal) =>
                          Array.isArray(item.data.terminal_ids_json) && item.data.terminal_ids_json.includes(terminal.terminal_id),
                        )}
                      />
                    );
                  }
                  return <PermissionMessage key={item.id} request={item.data} />;
                })}
              </div>
            </div>
            <div className="bg-pure-white shrink-0 w-full z-10 pb-4 md:pb-6">
              <div className="max-w-[768px] mx-auto px-4 md:px-6">
                <Composer
                  input={input}
                  setInput={setInput}
                  attachments={attachmentStates}
                  composerNotice={composerNotice}
                  activeWorkspace={activeWorkspace}
                  activeAgent={activeAgent}
                  modelSelector={modelSelector}
                  selectedModelValue={selectedModelValue}
                  selectedModelLabel={selectedModelLabel}
                  onModelChange={(value) => void handleModelChange(String(value))}
                  isSettingModel={isSettingModel}
                  onAttachClick={() => fileInputRef.current?.click()}
                  onDrop={handleDrop}
                  onPaste={handlePaste}
                  onRemoveAttachment={removeAttachment}
                  onSend={() => void handleSend()}
                  onKeyDown={handleKeyDown}
                  canSend={canSend}
                  isCompact
                />
              </div>
            </div>
          </>
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
                        <div className="text-[10px] text-silver font-medium uppercase tracking-wider">Installed Agents</div>
                      </div>
                      
                      <div className="border border-light-gray/60 rounded-container overflow-hidden bg-pure-white">
                        {agentDiscoveryStatus.map((agent, index) => (
                          <div 
                            key={agent.command} 
                            className={`group relative flex items-center justify-between py-3 px-4 transition-colors hover:bg-snow ${
                              index !== agentDiscoveryStatus.length - 1 ? 'border-b border-light-gray/30' : ''
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              <div className={`w-8 h-8 rounded-md flex items-center justify-center border border-light-gray/50 transition-colors p-1.5 ${
                                agent.installed ? 'bg-pure-white' : 'bg-snow opacity-50'
                              }`}>
                                <AgentLogo command={agent.command} className="w-full h-full object-contain" />
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
                              {agent.installed ? (
                                <span className="flex items-center gap-1 px-2 py-0.5 rounded-pill bg-light-gray/40 text-near-black text-[9px] font-medium uppercase tracking-wide">
                                  <div className="w-1.5 h-1.5 rounded-full bg-[#10b981]" />
                                  Ready
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 rounded-pill border border-light-gray/40 text-silver text-[9px] font-medium uppercase tracking-wide">
                                  Missing
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>

                    {installedAgents.length > 0 && (
                      <section className="px-1">
                        <div className="flex gap-3 p-3 rounded-container bg-snow border border-light-gray/20">
                          <AlertCircle className="w-3.5 h-3.5 text-stone shrink-0 mt-0.5" />
                          <p className="text-[11px] text-stone leading-relaxed">
                            Agents are automatically detected in your system <code className="text-pure-black font-medium">PATH</code>.
                          </p>
                        </div>
                      </section>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Composer({
  input,
  setInput,
  attachments,
  composerNotice,
  activeWorkspace,
  activeAgent,
  modelSelector,
  selectedModelValue,
  selectedModelLabel,
  onModelChange,
  isSettingModel,
  onAttachClick,
  onDrop,
  onPaste,
  onRemoveAttachment,
  onSend,
  onKeyDown,
  canSend,
  isCompact,
}: {
  input: string;
  setInput: (value: string) => void;
  attachments: Array<{ attachment: LocalAttachment; resolution: AttachmentResolution }>;
  composerNotice: string | null;
  activeWorkspace: Types.Workspace | null;
  activeAgent: Types.AgentProfile | null;
  modelSelector: ModelSelectorState | null;
  selectedModelValue: any;
  selectedModelLabel: string | null;
  onModelChange: (value: any) => void;
  isSettingModel: boolean;
  onAttachClick: () => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onRemoveAttachment: (id: string) => void;
  onSend: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  canSend: boolean;
  isCompact: boolean;
}) {
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const choices = modelSelector?.choices ?? [];
  const selectedChoice = choices.find(c => String(c.value) === String(selectedModelValue));

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
            {modelSelector ? (
              <>
                <button 
                  onClick={() => choices.length > 0 && !isSettingModel && setIsModelMenuOpen(!isModelMenuOpen)}
                  disabled={choices.length === 0 || isSettingModel}
                  className={`flex items-center gap-1.5 ${isCompact ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-small"} text-stone bg-pure-white border border-light-gray rounded-pill transition-colors select-none ${
                    choices.length > 0 && !isSettingModel ? "hover:text-pure-black hover:bg-snow" : "opacity-60 cursor-not-allowed"
                  }`}
                >
                  {isSettingModel ? <Loader2 className={isCompact ? "w-3 h-3 animate-spin" : "w-3.5 h-3.5 animate-spin"} /> : <Cpu className={isCompact ? "w-3 h-3" : "w-3.5 h-3.5"} />}
                  <span className="truncate max-w-[150px] font-medium">
                    {selectedChoice?.label || selectedModelLabel || (choices.length > 0 ? "Select Model" : "CLI Model")}
                  </span>
                  <ChevronDown className={`${isCompact ? "w-2.5 h-2.5" : "w-3 h-3"} transition-transform ${isModelMenuOpen ? 'rotate-180' : ''}`} />
                </button>
                
                <AnimatePresence>
                  {isModelMenuOpen && choices.length > 0 && (
                    <>
                      <div className="fixed inset-0 z-[60]" onClick={() => setIsModelMenuOpen(false)} />
                      <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: 5 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 5 }}
                        className="absolute bottom-full left-0 mb-2 w-max min-w-[220px] max-w-[320px] max-h-[300px] overflow-y-auto bg-pure-white border border-light-gray rounded-container z-[70] p-1.5"
                      >
                        {choices.map((choice) => (
                          <button
                            key={String(choice.value)}
                            onClick={() => {
                              onModelChange(choice.value);
                              setIsModelMenuOpen(false);
                            }}
                            className={`w-full text-left px-3 py-2 rounded-container text-[13px] transition-colors flex items-center justify-between gap-4 ${
                              String(choice.value) === String(selectedModelValue)
                                ? 'bg-light-gray text-pure-black font-medium'
                                : 'text-near-black hover:bg-snow'
                            }`}
                          >
                            <span className="truncate">{choice.label}</span>
                            {String(choice.value) === String(selectedModelValue) && (
                              <div className="w-1.5 h-1.5 rounded-full bg-pure-black shrink-0" />
                            )}
                          </button>
                        ))}
                      </motion.div>
                    </>
                  )}
                </AnimatePresence>
              </>
            ) : (
              <div
                className={`flex items-center gap-1.5 ${isCompact ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-small"} text-silver bg-snow border border-light-gray rounded-pill opacity-60`}
              >
                <Cpu className={isCompact ? "w-3 h-3" : "w-3.5 h-3.5"} />
                <span className="truncate max-w-[120px]">{activeAgent?.name || "Model"}</span>
                <ChevronDown className={`${isCompact ? "w-2.5 h-2.5" : "w-3 h-3"} opacity-30`} />
              </div>
            )}
          </div>

          <div className={`flex items-center gap-1.5 ${isCompact ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-small"} text-stone bg-pure-white border border-light-gray rounded-pill`}>
            <Folder className={isCompact ? "w-3 h-3" : "w-3.5 h-3.5"} />
            <span className="truncate max-w-[120px]">{activeWorkspace?.display_name || "Workspace"}</span>
          </div>
        </div>

        <button
          className={`${isCompact ? "p-1.5" : "p-2.5"} rounded-pill transition-colors shrink-0 flex items-center justify-center ${canSend ? "bg-pure-black text-pure-white" : "bg-light-gray text-silver"}`}
          disabled={!canSend}
          onClick={onSend}
        >
          <ArrowUp className={isCompact ? "w-3.5 h-3.5" : "w-4 h-4"} />
        </button>
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
      className={`group w-full rounded-md flex items-center gap-1 min-w-0 border border-transparent ${active ? "bg-light-gray/50" : "hover:bg-light-gray/50"}`}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex-1 text-left px-2 py-1.5 flex items-center gap-2.5 min-w-0 rounded-md"
      >
        <div className={`w-5 h-5 flex items-center justify-center shrink-0 ${active ? 'opacity-100' : 'opacity-40'}`}>
          {agentCommand ? <AgentLogo command={agentCommand} className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
        </div>
        <span className={`text-[13px] truncate flex-1 ${active ? "text-pure-black font-medium" : "text-near-black"}`}>{title}</span>
      </button>
      {onDelete && (
        deletePending ? (
          <div className="flex items-center gap-1 pr-1 shrink-0">
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDelete();
              }}
              className="px-2 py-1 rounded-md bg-rose-600 text-pure-white text-[11px] font-medium hover:bg-rose-700 transition-colors"
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
              className="p-1 rounded-md text-stone hover:text-pure-black hover:bg-pure-white transition-colors"
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
            className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-stone hover:text-rose-600 hover:bg-pure-white transition-all shrink-0 cursor-pointer mr-1"
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
}: {
  message: Types.MessageProjection;
  terminals: Types.TerminalRecord[];
}) {
  if (message.kind === "plan") {
    return <PlanMessage entries={Array.isArray(message.content_json?.entries) ? message.content_json.entries : []} />;
  }
  if (message.kind === "terminal") {
    return (
      <TerminalMessage
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
  return (
    <Message
      role={message.role as "user" | "agent" | "assistant" | "tool" | "system"}
      content={message.content_json?.text || message.content_json?.message || ""}
      attachments={Array.isArray(message.content_json?.attachments) ? message.content_json.attachments : []}
      kind={message.kind}
      contentJson={message.content_json}
    />
  );
}

function Message({
  role,
  content,
  attachments,
  kind,
  contentJson,
}: {
  role: "user" | "agent" | "assistant" | "tool" | "system";
  content: string;
  attachments: Types.AttachmentInput[];
  kind?: string;
  contentJson?: any;
}) {
  const isUser = role === "user";
  const isDiff = kind === "diff";
  
  // Efficiently strip tags without unnecessary state if possible
  const displayContent = useMemo(() => {
    if (isUser || isDiff || !content) return content;
    // Strip <think> and <thinking> blocks including incomplete ones (important for streaming)
    return content
      .replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "")
      .replace(/<thinking>[\s\S]*?(?:<\/thinking>|$)/g, "")
      .trim();
  }, [content, isUser, isDiff]);

  if (!displayContent && !isUser && !isDiff && attachments.length === 0) return null;

  return (
    <div className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`flex flex-col gap-2 min-w-0 w-full ${isUser ? "max-w-[95%] md:max-w-[85%] items-end" : "items-start"} mt-1`}>
        <div className={`text-caption leading-relaxed break-words min-w-0 w-fit max-w-full ${isUser ? "bg-light-gray px-4 py-2 rounded-container" : "text-pure-black py-2 px-4"}`}>
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
      <div className="w-full max-w-[95%] md:max-w-[85%] border border-rose-200 bg-rose-50 rounded-container px-4 py-3 text-rose-700">
        <div className="flex items-center gap-2 mb-1">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="text-[11px] font-medium uppercase tracking-wider">Error</span>
        </div>
        <div className="text-[14px] leading-relaxed whitespace-pre-wrap">{content || "Unknown error"}</div>
      </div>
    </div>
  );
}

function TerminalMessage({
  content,
  stream,
  event,
  terminal,
}: {
  content: string;
  stream: string;
  event: string;
  terminal: Types.TerminalRecord | null;
}) {
  return (
    <div className="flex w-full justify-start mt-1 mb-2">
      <div className="w-full max-w-[95%] md:max-w-[85%] border border-light-gray rounded-container bg-pure-white overflow-hidden">
        <div className="px-4 py-2 border-b border-light-gray bg-snow flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-stone" />
          <span className="text-[11px] font-medium uppercase tracking-wider text-stone">
            {terminal?.command || "Terminal"}{stream ? ` · ${stream}` : ""}
          </span>
          <span className="text-[10px] text-silver uppercase tracking-wider">{event}</span>
        </div>
        <pre className="p-3 text-[12px] font-mono overflow-x-auto whitespace-pre-wrap break-words text-near-black">
          {content || "..."}
        </pre>
      </div>
    </div>
  );
}

function ThinkingMessage({
  content,
  status,
  duration_ms,
}: {
  content: string;
  status: "thinking" | "done";
  duration_ms?: number | null;
}) {
  const [isExpanded, setIsExpanded] = useState(status === "thinking");

  // Auto-expand while thinking, and collapse when done if it was a new message
  useEffect(() => {
    if (status === "thinking") {
      setIsExpanded(true);
    }
  }, [status]);

  return (
    <div className="flex w-full justify-start mt-1 mb-2">
      <div className="flex flex-col gap-2 min-w-0 w-full max-w-[95%] md:max-w-[85%] items-start">
        <div className="w-full border border-light-gray rounded-container bg-snow overflow-hidden">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="w-full flex items-center justify-between px-4 py-2 hover:bg-light-gray/20 transition-colors text-left"
          >
            <div className="flex items-center gap-2">
              {status === "thinking" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-stone" />
              ) : (
                <div className="w-3.5 h-3.5 rounded-full border border-light-gray flex items-center justify-center shrink-0">
                  <div className="w-1.5 h-1.5 rounded-full bg-stone" />
                </div>
              )}
              <span className="text-[11px] font-medium text-stone uppercase tracking-wider">
                {status === "thinking" ? "Thinking" : "Thought"}
              </span>
              {status === "done" && duration_ms !== undefined && duration_ms !== null && (
                <span className="text-[11px] text-silver font-mono">
                  {(duration_ms / 1000).toFixed(1)}s
                </span>
              )}
            </div>
            <ChevronDown className={`w-3.5 h-3.5 text-silver transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`} />
          </button>
          
          <AnimatePresence initial={false}>
            {isExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
              >
                <div className="px-4 pb-3 text-caption text-stone leading-relaxed whitespace-pre-wrap border-t border-light-gray/30 pt-2">
                  {content || "..."}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function ToolCallMessage({
  toolCall,
  terminals,
}: {
  toolCall: Types.ToolCallProjection;
  terminals: Types.TerminalRecord[];
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const status = toolCall.status.toLowerCase();
  const isRunning = status === "running" || status === "declared";
  const isFailed = status === "failed" || status === "cancelled";
  
  const getIcon = () => {
    const kind = toolCall.kind.toLowerCase();
    if (kind.includes("terminal") || kind.includes("shell") || kind.includes("execute")) return <Terminal className="w-3.5 h-3.5" />;
    if (kind.includes("edit") || kind.includes("write") || kind.includes("fs")) return <Code className="w-3.5 h-3.5" />;
    return <Cpu className="w-3.5 h-3.5" />;
  };

  const inputSummary = useMemo(() => {
    const input = toolCall.raw_input_json;
    if (!input) return "";
    if (typeof input === "string") return input;
    if (input.command) return `${input.command} ${Array.isArray(input.args) ? input.args.join(" ") : ""}`;
    if (input.path) return input.path;
    return JSON.stringify(input);
  }, [toolCall.raw_input_json]);

  return (
    <div className="flex w-full justify-start mt-1 mb-2">
      <div className="flex flex-col gap-2 min-w-0 w-full max-w-[95%] md:max-w-[85%] items-start">
        <div className="w-full border border-light-gray rounded-container bg-snow overflow-hidden transition-all">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="w-full flex items-center justify-between px-4 py-2 hover:bg-light-gray/20 transition-colors text-left"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className={`flex items-center justify-center w-6 h-6 rounded-md border ${
                isFailed ? "bg-rose-50 border-rose-200 text-rose-600" : 
                isRunning ? "bg-blue-50 border-blue-200 text-blue-600" :
                "bg-pure-white border-light-gray text-stone"
              }`}>
                {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : getIcon()}
              </div>
              <div className="flex flex-col min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-stone uppercase tracking-wider truncate">
                    {toolCall.title || toolCall.kind}
                  </span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-pill font-medium uppercase tracking-tight ${
                    isFailed ? "bg-rose-100 text-rose-700" :
                    isRunning ? "bg-blue-100 text-blue-700" :
                    "bg-light-gray/50 text-stone"
                  }`}>
                    {status}
                  </span>
                </div>
                {inputSummary && !isExpanded && (
                  <span className="text-[11px] text-silver truncate font-mono max-w-[300px]">
                    {inputSummary}
                  </span>
                )}
              </div>
            </div>
            <ChevronDown className={`w-3.5 h-3.5 text-silver transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`} />
          </button>
          
          <AnimatePresence initial={false}>
            {isExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
              >
                <div className="px-4 pb-3 border-t border-light-gray/30 pt-3 space-y-3">
                  {toolCall.raw_input_json && (
                    <div>
                      <div className="text-[10px] text-silver font-medium uppercase tracking-wider mb-1">Input</div>
                      <pre className="text-[12px] font-mono bg-pure-white p-2 rounded-container border border-light-gray overflow-x-auto text-near-black">
                        {JSON.stringify(toolCall.raw_input_json, null, 2)}
                      </pre>
                    </div>
                  )}
                  {toolCall.raw_output_json && (
                    <div>
                      <div className="text-[10px] text-silver font-medium uppercase tracking-wider mb-1">Output</div>
                      <pre className="text-[12px] font-mono bg-pure-white p-2 rounded-container border border-light-gray overflow-x-auto text-stone max-h-[300px] overflow-y-auto">
                        {typeof toolCall.raw_output_json === 'string' 
                          ? toolCall.raw_output_json 
                          : JSON.stringify(toolCall.raw_output_json, null, 2)}
                      </pre>
                    </div>
                  )}
                  {terminals.length > 0 && (
                    <div>
                      <div className="text-[10px] text-silver font-medium uppercase tracking-wider mb-1">Terminals</div>
                      <div className="space-y-2">
                        {terminals.map((terminal) => (
                          <div key={terminal.id} className="rounded-container border border-light-gray bg-pure-white p-2">
                            <div className="text-[11px] font-mono text-near-black truncate">
                              {terminal.command} {Array.isArray(terminal.args_json) ? terminal.args_json.join(" ") : ""}
                            </div>
                            <div className="text-[11px] text-silver uppercase tracking-wider mt-1">{terminal.status}</div>
                            {(terminal.stdout_buffer || terminal.stderr_buffer) && (
                              <pre className="mt-2 text-[11px] font-mono whitespace-pre-wrap break-words max-h-[160px] overflow-y-auto text-stone">
                                {terminal.stdout_buffer || terminal.stderr_buffer}
                              </pre>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function PermissionMessage({
  request,
}: {
  request: Types.PendingPermissionRequest;
}) {
  const [isSubmitting, setIsSubmitting] = useState<string | null>(null);
  const optionCount = Array.isArray(request.options_json) ? request.options_json.length : 0;
  const options = Array.isArray(request.options_json) ? request.options_json : [];
  const isResolved = request.status !== "pending";

  const optionMeta = (option: any) => {
    const kind = String(option?.kind || "");
    switch (kind) {
      case "allow_once":
        return { label: "Allow Once", decision: "allow_once" as const, tone: "light" as const };
      case "allow_always":
        return { label: "Always Allow", decision: "allow_always" as const, tone: "dark" as const };
      case "reject_once":
        return { label: "Reject Once", decision: "reject_once" as const, tone: "light" as const };
      case "reject_always":
        return { label: "Always Reject", decision: "reject_always" as const, tone: "light" as const };
      case "cancelled":
        return { label: "Cancel", decision: "cancelled" as const, tone: "light" as const };
      default:
        return {
          label: String(option?.name || option?.label || option?.title || kind || "Confirm"),
          decision: kind as Types.ResolvePermissionInput["decision"],
          tone: "light" as const,
        };
    }
  };

  const handleResolve = async (option: any) => {
    const meta = optionMeta(option);
    if (isResolved || isSubmitting || !meta.decision) return;
    setIsSubmitting(meta.decision);
    try {
      await API.resolvePermissionRequest({
        conversation_id: request.conversation_id,
        tool_call_id: request.tool_call_id,
        fingerprint: request.fingerprint,
        decision: meta.decision,
      });
    } catch (error) {
      console.error("Failed to resolve permission request", error);
    } finally {
      setIsSubmitting(null);
    }
  };

  return (
    <div className="flex w-full justify-start mt-1 mb-2">
      <div className="w-full max-w-[95%] md:max-w-[85%] border border-light-gray rounded-container bg-snow px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <AlertCircle className="w-4 h-4 text-stone shrink-0" />
          <span className="text-[11px] font-medium uppercase tracking-wider text-stone">
            Permission {request.status}
          </span>
        </div>
        <div className="text-[14px] text-pure-black leading-relaxed">
          Tool call <span className="font-mono">{request.tool_call_id}</span> requested approval.
        </div>
        <div className="text-[12px] text-stone mt-1">
          {isResolved
            ? "Decision recorded."
            : optionCount > 0
              ? `${optionCount} options available`
              : "Waiting for permission options"}
        </div>
        {options.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {options.map((option: any, index: number) => {
              const meta = optionMeta(option);
              const isActive = isSubmitting === meta.decision;
              return (
                <button
                  key={option.optionId || option.id || option.kind || index}
                  onClick={() => void handleResolve(option)}
                  disabled={isResolved || !!isSubmitting}
                  className={`inline-flex items-center justify-center rounded-full border px-4 py-2 text-[12px] transition-colors ${
                    meta.tone === "dark"
                      ? "border-pure-black bg-pure-black text-pure-white"
                      : "border-light-gray bg-pure-white text-near-black"
                  } ${isResolved || !!isSubmitting ? "opacity-60 cursor-not-allowed" : "hover:bg-light-gray/40"}`}
                >
                  {isActive ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : meta.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
