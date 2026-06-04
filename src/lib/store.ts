import { create } from 'zustand';
import type * as Types from './backend/types';
import * as API from './backend/commands';
import * as Events from './backend/events';
import { IS_TAURI, getToken, subscribeAuthState, login as apiLogin, logout as apiLogout, type UnlistenFn } from './backend/transport';
import {
  readSettingsStorage,
  writeSettingsStorage,
  buildConversationTitle,
  isConversationActive,
  findConversationAcrossWorkspaces,
  compareIsoTimestamp,
  sortMessages,
  timelineItemKey,
  buildTimelineItems,
  upsertTimelineItem,
  mergeTimelineItems,
  mergeTimelineMessage,
  mergeToolCall,
  mergeTerminal,
  mergePendingPermission,
  recordAgentUsage,
  getSortedAgentProfiles,
  type TimelineItem,
} from './utils';
import { SYNC_CONFIG } from './constants';

let activeTurnSyncToken = 0;

// Store unlisten functions for cleanup
let eventUnlisteners: UnlistenFn[] = [];

function startConversationSync(
  conversationId: string,
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
) {
  const syncToken = ++activeTurnSyncToken;
  // Grace period: the first few polls may hit the backend before the spawned
  // turn task has transitioned the state to Running.  To avoid stopping the
  // sync loop prematurely we allow up to GRACE_POLLS polls that return a
  // non-active state before we actually give up.
  const GRACE_POLLS = SYNC_CONFIG.GRACE_POLLS;
  let idleSeen = 0;
  void (async () => {
    for (let attempt = 0; attempt < SYNC_CONFIG.MAX_POLL_ATTEMPTS; attempt += 1) {
      if (syncToken !== activeTurnSyncToken) return;

      try {
        const [timeline, state] = await Promise.all([
          API.getConversationTimeline(conversationId),
          API.getConversationState(conversationId),
        ]);

        if (syncToken !== activeTurnSyncToken) return;

        set((current: AppState) => ({
          activeTimeline:
            current.activeConversationId === conversationId ? timeline : current.activeTimeline,
          activeTimelineItems:
            current.activeConversationId === conversationId
              ? mergeTimelineItems(current.activeTimelineItems, timeline)
              : current.activeTimelineItems,
          activeConversationState:
            current.activeConversationId === conversationId ? state : current.activeConversationState,
        }));

        if (!isConversationActive(state)) {
          idleSeen += 1;
          // During the grace period keep polling so a slow backend spawn
          // doesn't cause us to miss the entire turn.
          if (idleSeen > GRACE_POLLS) {
            if (syncToken === activeTurnSyncToken) {
              activeTurnSyncToken += 1;
            }
            return;
          }
        } else {
          // Reset grace counter once we confirm the turn is active.
          idleSeen = 0;
        }
      } catch (error) {
        console.error('Failed to sync active conversation', conversationId, error);
      }

      if (get().activeConversationId !== conversationId) {
        return;
      }

      await new Promise((resolve) => window.setTimeout(resolve, SYNC_CONFIG.POLL_INTERVAL_MS));
    }
  })();
}

async function refreshActiveConversation(
  conversationId: string,
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
) {
  try {
    const [timeline, conversationState] = await Promise.all([
      API.getConversationTimeline(conversationId),
      API.getConversationState(conversationId),
    ]);
    const activeWsId = get().activeWorkspace?.id;
    set((state) => {
      const newWorkspaceConversations = new Map(state.workspaceConversations);
      const currentConversations = newWorkspaceConversations.get(activeWsId ?? '') ?? [];
      const updatedConversations = currentConversations.map((conversation) =>
        conversation.id === conversationId ? { ...conversation, status: conversationState.conversation.status } : conversation,
      );
      newWorkspaceConversations.set(activeWsId ?? '', updatedConversations);
      return {
        workspaceConversations: newWorkspaceConversations,
        conversations: state.activeConversationId === conversationId ? updatedConversations : state.conversations,
        activeTimeline: state.activeConversationId === conversationId ? timeline : state.activeTimeline,
        activeTimelineItems:
          state.activeConversationId === conversationId
            ? mergeTimelineItems(state.activeTimelineItems, timeline)
            : state.activeTimelineItems,
        activeConversationState:
          state.activeConversationId === conversationId ? conversationState : state.activeConversationState,
      };
    });
    if (isConversationActive(conversationState) && get().activeConversationId === conversationId) {
      startConversationSync(conversationId, set, get);
    }
  } catch (error) {
    console.error('Failed to refresh active conversation', conversationId, error);
  }
}

interface AppState {
  isInitializing: boolean;
  isAuthenticated: boolean;
  hasEventSubscriptions: boolean;

  // Workspace
  workspaces: Types.Workspace[];
  activeWorkspace: Types.Workspace | null;
  mcpServers: Types.McpServerConfig[];
  mcpStatuses: Map<string, Types.McpServerStatus>;
  skills: Types.SkillRecord[];
  agentDiscoveryStatus: Types.AgentDiscoveryStatus[];

  // Agent
  agentProfiles: Types.AgentProfile[];
  activeAgentProfileId: string | null;

  // Conversations - keyed by workspace_id for multi-workspace support
  workspaceConversations: Map<string, Types.Conversation[]>;
  conversations: Types.Conversation[]; // current workspace's conversations
  discoveredSessions: Types.ExternalSession[];
  activeConversationId: string | null;
  activeConversationState: Types.ConversationState | null;

  // Timeline Data
  activeTimeline: Types.TimelineResponse | null;
  activeTimelineItems: TimelineItem[];

  // Unread completed conversations (for notification dot in sidebar)
  unreadCompletedConversations: Set<string>;

  // Running conversations (to detect completion transition)
  runningConversations: Set<string>;

  // User Settings
  alwaysExpandThinking: boolean;
  showAgentIconInList: boolean;
  webuiEnabled: boolean;
  webuiPassword: string | null;
  webuiInfo: { port: number; urls: string[] } | null;

  // Browser Use State
  browserStatus: Types.BrowserSessionStatus;
  browserConfig: Types.BrowserSessionConfig | null;
  browserScreenshot: string | null;  // base64 PNG
  browserUrl: string | null;
  browserPageTitle: string | null;
  browserNavigating: boolean;

  // Actions
  init: () => Promise<void>;
  selectConversation: (id: string | null) => Promise<void>;
  setActiveAgentProfile: (id: string | null) => void;
  ensureAgentCapabilities: (profileId: string) => Promise<Types.AgentCapabilities | null>;
  sendMessage: (
    text: string,
    attachments?: Types.AttachmentInput[],
    sessionConfigOverrides?: Array<{ config_id: string; value: any }>,
  ) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  setSessionConfig: (configId: string, value: any) => Promise<void>;
  setModel: (modelId: string) => Promise<void>;
  setMode: (modeId: string) => Promise<void>;
  cancelTurn: () => Promise<void>;

  // Workspace Actions
  switchWorkspace: (workspace: Types.Workspace) => Promise<void>;
  pickWorkspace: () => Promise<Types.Workspace | null>;
  refreshWorkspaces: () => Promise<void>;
  archiveWorkspace: (workspaceId: string) => Promise<void>;

  // Settings Actions
  setAlwaysExpandThinking: (value: boolean) => void;
  setShowAgentIconInList: (value: boolean) => void;
  setWebuiEnabled: (value: boolean) => Promise<string | null>;

  // MCP Actions
  refreshMcpServers: () => Promise<void>;
  upsertMcpServer: (config: Types.McpServerConfig) => Promise<void>;
  deleteMcpServer: (id: string) => Promise<void>;
  testMcpConnection: (config: Types.McpServerConfig) => Promise<Types.McpServerStatus>;
  importMcpConfigs: (jsonString: string) => Promise<void>;
  reloadMcpConnection: (config: Types.McpServerConfig) => Promise<void>;
  reloadAllMcpConnections: () => Promise<void>;
  getMcpConnectionStatus: () => Promise<Types.McpServerStatus[]>;
  updateMcpStatus: (workspaceId: string, status: Types.McpServerStatus) => void;
  clearMcpStatuses: () => void;

  // Browser Use Actions
  startBrowser: (config?: Partial<Types.BrowserSessionConfig>) => Promise<void>;
  stopBrowser: () => Promise<void>;
  refreshBrowserStatus: () => Promise<void>;
  loadBrowserConfig: (workspaceId: string) => Promise<void>;
  saveBrowserConfig: (workspaceId: string, config: Types.BrowserSessionConfig) => Promise<void>;
  navigateBrowser: (url: string) => Promise<void>;
  browserReload: () => Promise<void>;
  browserGoBack: () => Promise<void>;
  browserGoForward: () => Promise<void>;

  login: (password: string) => Promise<boolean>;
  logout: () => Promise<void>;

  // Event Handlers
  _setupEventSubscriptions: () => void;
  _teardownEventSubscriptions: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  isInitializing: true,
  isAuthenticated: IS_TAURI || !!getToken(),
  hasEventSubscriptions: false,

  workspaces: [],
  activeWorkspace: null,
  mcpServers: [],
  mcpStatuses: new Map(),
  skills: [],
  agentDiscoveryStatus: [],

  agentProfiles: [],
  activeAgentProfileId: null,

  workspaceConversations: new Map(),
  conversations: [],
  discoveredSessions: [],
  activeConversationId: null,
  activeConversationState: null,

  activeTimeline: null,
  activeTimelineItems: [],
  unreadCompletedConversations: new Set(),
  runningConversations: new Set(),

  // Initialize settings from localStorage
  alwaysExpandThinking: readSettingsStorage()?.alwaysExpandThinking ?? false,
  showAgentIconInList: readSettingsStorage()?.showAgentIconInList ?? true,
  webuiEnabled: false,
  webuiPassword: null,
  webuiInfo: null,

  // Browser Use initial state
  browserStatus: { state: 'stopped' },
  browserConfig: null,
  browserScreenshot: null,
  browserUrl: null,
  browserPageTitle: null,
  browserNavigating: false,

  init: async () => {
    if (!IS_TAURI && !getToken()) {
      set({ isAuthenticated: false, isInitializing: false });
      return;
    }
    // Clean up existing event listeners before re-initializing
    get()._teardownEventSubscriptions();
    try {
      // 1. Load all workspaces from backend
      const allWorkspaces = await API.listWorkspaces();

      // 2. Get or create the default workspace at ~/.oneagent/workspace/
      const defaultWorkspace = await API.getOrCreateDefaultWorkspace();

      // Ensure default workspace is in the list
      const workspaces = allWorkspaces.find(w => w.id === defaultWorkspace.id)
        ? allWorkspaces
        : [defaultWorkspace, ...allWorkspaces];

      // 3. Bootstrap the default/active workspace
      const bootstrapData = await API.bootstrapWorkspace({
        workspace_id: defaultWorkspace.id,
      });

      // Initialize workspaceConversations Map with default workspace conversations
      const workspaceConversations = new Map<string, Types.Conversation[]>();
      workspaceConversations.set(defaultWorkspace.id, bootstrapData.conversations);

      let webuiEnabled = false;
      let webuiPassword: string | null = null;
      let webuiInfo: { port: number; urls: string[] } | null = null;
      if (IS_TAURI) {
        try {
          webuiEnabled = await API.getWebuiEnabled();
          if (webuiEnabled) {
            webuiPassword = await API.getWebuiPassword();
            webuiInfo = await API.getWebuiInfo();
          }
        } catch (error) {
          console.error('Failed to get WebUI setting', error);
        }
      }

      const sortedProfiles = getSortedAgentProfiles(bootstrapData.agent_profiles);
      set({
        workspaces,
        activeWorkspace: bootstrapData.workspace,
        workspaceConversations,
        conversations: bootstrapData.conversations,
        agentProfiles: sortedProfiles,
        discoveredSessions: bootstrapData.discovered_sessions,
        mcpServers: bootstrapData.mcp,
        skills: bootstrapData.skills,
        activeAgentProfileId: sortedProfiles.length > 0 ? sortedProfiles[0].id : null,
        activeConversationState: null,
        isInitializing: false,
        isAuthenticated: true,
        webuiEnabled,
        webuiPassword,
        webuiInfo,
      });

      // 4. Set up event listeners
      get()._setupEventSubscriptions();

      // 5. Fetch initial MCP connection status (backend auto-starts connections on bootstrap)
      void get().getMcpConnectionStatus();

      // 6. Refresh agent discovery state in the background
      void Promise.allSettled([API.listAgentProfiles(), API.listAgentDiscoveryStatus()]).then((results) => {
        const [profilesResult, discoveryResult] = results;
        set((state) => {
          const nextProfiles =
            profilesResult.status === 'fulfilled' ? profilesResult.value : state.agentProfiles;
          const sortedProfiles = getSortedAgentProfiles(nextProfiles);
          const nextActiveAgentProfileId =
            state.activeAgentProfileId ?? sortedProfiles[0]?.id ?? null;
          return {
            agentProfiles: sortedProfiles,
            agentDiscoveryStatus:
              discoveryResult.status === 'fulfilled' ? discoveryResult.value : state.agentDiscoveryStatus,
            activeAgentProfileId: nextActiveAgentProfileId,
          };
        });
      });

      const preloadTargets = workspaces.filter((workspace) => workspace.id !== defaultWorkspace.id);
      void Promise.allSettled(
        preloadTargets.map(async (workspace) => {
          const data = await API.bootstrapWorkspace({ workspace_id: workspace.id });
          return { workspaceId: workspace.id, conversations: data.conversations };
        }),
      ).then((results) => {
        set((state) => {
          const nextWorkspaceConversations = new Map(state.workspaceConversations);
          let changed = false;

          for (const result of results) {
            if (result.status !== 'fulfilled') continue;
            nextWorkspaceConversations.set(result.value.workspaceId, result.value.conversations);
            changed = true;
          }

          return changed ? { workspaceConversations: nextWorkspaceConversations } : state;
        });
      });

    } catch (error) {
      console.error('Failed to initialize app state:', error);
      set({ isInitializing: false });
    }
  },

  selectConversation: async (id: string | null) => {
    activeTurnSyncToken += 1;
    const syncToken = activeTurnSyncToken;
    const selectedEntry = id
      ? findConversationAcrossWorkspaces(get().workspaceConversations, id)
      : null;
    const selectedConversation = selectedEntry?.conversation ?? null;

    // Mark conversation as read when user selects it
    const nextUnread = new Set(get().unreadCompletedConversations);
    if (id && nextUnread.has(id)) {
      nextUnread.delete(id);
    }

    if (selectedConversation) {
      recordAgentUsage(selectedConversation.agent_profile_id);
    }

    set((state) => ({
      activeConversationId: id,
      activeAgentProfileId: selectedConversation?.agent_profile_id ?? state.activeAgentProfileId,
      activeConversationState: null,
      activeTimeline: null,
      activeTimelineItems: [],
      unreadCompletedConversations: nextUnread,
      agentProfiles: getSortedAgentProfiles(state.agentProfiles),
    }));

    if (id) {
      try {
        if (selectedEntry && get().activeWorkspace?.id !== selectedEntry.workspaceId) {
          const bootstrapData = await API.bootstrapWorkspace({
            workspace_id: selectedEntry.workspaceId,
          });

          if (syncToken !== activeTurnSyncToken) return;

          set((state) => {
            const workspaceConversations = new Map(state.workspaceConversations);
            workspaceConversations.set(selectedEntry.workspaceId, bootstrapData.conversations);

            const sortedProfiles = getSortedAgentProfiles(bootstrapData.agent_profiles);
            return {
              activeWorkspace: bootstrapData.workspace,
              workspaceConversations,
              conversations: bootstrapData.conversations,
              agentProfiles: sortedProfiles,
              discoveredSessions: bootstrapData.discovered_sessions,
              mcpServers: bootstrapData.mcp,
              mcpStatuses: new Map(),
              skills: bootstrapData.skills,
              activeAgentProfileId:
                selectedConversation?.agent_profile_id
                ?? sortedProfiles[0]?.id
                ?? state.activeAgentProfileId,
            };
          });

          // Refresh MCP connection status for the newly selected workspace
          void get().getMcpConnectionStatus();
        }

        const [timeline, conversationState] = await Promise.all([
          API.getConversationTimeline(id),
          API.getConversationState(id),
        ]);

        if (syncToken !== activeTurnSyncToken) return;

        set({
          activeTimeline: timeline,
          activeTimelineItems: buildTimelineItems(timeline),
          activeConversationState: conversationState,
        });

        if (isConversationActive(conversationState)) {
          startConversationSync(id, set, get);
        }
      } catch (error) {
        console.error('Failed to fetch timeline for conversation', id, error);
        if (syncToken !== activeTurnSyncToken) return;
        set({ activeTimeline: null, activeTimelineItems: [], activeConversationState: null });
      }
    } else {
      set({ activeTimeline: null, activeTimelineItems: [], activeConversationState: null });
    }
  },

  setActiveAgentProfile: (id: string | null) => {
    if (id) {
      recordAgentUsage(id);
    }
    set((state) => ({
      activeAgentProfileId: id,
      agentProfiles: getSortedAgentProfiles(state.agentProfiles),
    }));
  },

  ensureAgentCapabilities: async (profileId: string) => {
    const existing = get().agentProfiles.find((profile) => profile.id === profileId)?.capabilities_cache;
    if (existing && existing.prompt_capabilities) {
      return existing;
    }
    try {
      const capabilities = await API.probeAgentProfile(profileId);
      set((state) => ({
        agentProfiles: state.agentProfiles.map((profile) =>
          profile.id === profileId ? { ...profile, capabilities_cache: capabilities } : profile
        ),
      }));
      return capabilities;
    } catch (error) {
      console.error('Failed to probe agent capabilities', error);
      throw error;
    }
  },

  sendMessage: async (
    text: string,
    attachments: Types.AttachmentInput[] = [],
    sessionConfigOverrides: Array<{ config_id: string; value: any }> = [],
  ) => {
    const state = get();

    if (!state.activeWorkspace) return;
    if (!state.activeAgentProfileId) {
      console.error("No active agent profile selected");
      return;
    }

    recordAgentUsage(state.activeAgentProfileId);

    // Separate model overrides from other config overrides
    const modeOverrides = sessionConfigOverrides.filter(
      (override) => override.config_id === '__mode_override__'
    );
    const modelOverrides = sessionConfigOverrides.filter(
      (override) => override.config_id.toLowerCase().includes('model') && override.config_id !== '__mode_override__'
    );
    const otherConfigOverrides = sessionConfigOverrides.filter(
      (override) => !override.config_id.toLowerCase().includes('model') && override.config_id !== '__mode_override__'
    );

    let conversationId = state.activeConversationId;
    let pendingConversationId: string | null = null;
    const activeWsId = state.activeWorkspace.id;
    const currentConversations = state.workspaceConversations.get(activeWsId) ?? [];

    if (!conversationId) {
      pendingConversationId = `local-conversation-${Date.now()}`;
      const pendingTurnId = `local-turn-${pendingConversationId}`;
      const pendingConversation: Types.Conversation = {
        id: pendingConversationId,
        workspace_id: activeWsId,
        agent_profile_id: state.activeAgentProfileId,
        origin: 'oneagent_managed',
        status: 'starting',
        title: buildConversationTitle(text),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_event_seq: 0,
      };

      const newWorkspaceConversations = new Map(state.workspaceConversations);
      newWorkspaceConversations.set(activeWsId, [pendingConversation, ...currentConversations]);

      set((s) => ({
        workspaceConversations: newWorkspaceConversations,
        conversations: [pendingConversation, ...s.conversations],
        activeConversationId: pendingConversationId,
        agentProfiles: getSortedAgentProfiles(s.agentProfiles),
        activeConversationState: {
          conversation: pendingConversation,
          runtime: {
            connection_phase: 'initializing',
            session_phase: 'cold',
            turn_phase: 'idle',
            last_error: null,
            last_transition_at: new Date().toISOString(),
          },
          binding: null,
          task_run: null,
          config_options: [],
          available_commands: [],
          pending_permissions: [],
        },
        activeTimeline: {
          events: [],
          messages: [],
          tool_calls: [],
          pending_permissions: [],
          terminals: [],
        },
        activeTimelineItems: [],
      }));
      try {
        let newConvState = await API.createConversation({
          workspace_id: activeWsId,
          agent_profile_id: state.activeAgentProfileId,
          title: pendingConversation.title,
        });
        conversationId = newConvState.conversation.id;

        // Apply mode overrides using setMode API
        for (const modeOverride of modeOverrides) {
          try {
            const modes = await API.setMode({
              conversation_id: conversationId,
              mode_id: String(modeOverride.value),
            });
            newConvState = { ...newConvState, modes };
          } catch (error) {
            console.error('Failed to set mode for new conversation', error);
          }
        }

        // Apply model overrides first using setModel API
        for (const modelOverride of modelOverrides) {
          try {
            const models = await API.setModel({
              conversation_id: conversationId,
              model_id: String(modelOverride.value),
            });
            newConvState = { ...newConvState, models };
          } catch (error) {
            console.error('Failed to set model for new conversation', error);
          }
        }

        // Apply other config overrides using setSessionConfig
        if (otherConfigOverrides.length > 0) {
          for (const override of otherConfigOverrides) {
            await API.setSessionConfig({
              conversation_id: conversationId,
              config_id: override.config_id,
              value: override.value,
            });
          }
          newConvState = await API.getConversationState(conversationId);
        } else if (modelOverrides.length > 0) {
          newConvState = await API.getConversationState(conversationId);
        }

        set((s) => {
          const wsConv = new Map(s.workspaceConversations);
          const convs = wsConv.get(activeWsId) ?? [];

          // Replace pending conversation with real one
          let updatedConvs = convs.map((conversation) =>
            conversation.id === pendingConversationId ? newConvState.conversation : conversation
          );

          // Deduplicate: remove any duplicate that may have been added via state_changed event
          // (race condition: event arrives before replacement completes)
          const realId = newConvState.conversation.id;
          updatedConvs = updatedConvs.filter((conv, index, self) =>
            self.findIndex(c => c.id === conv.id) === index
          );

          wsConv.set(activeWsId, updatedConvs);

          // Also deduplicate the conversations list
          const deduplicatedConversations = s.conversations
            .map((conversation) =>
              conversation.id === pendingConversationId ? newConvState.conversation : conversation
            )
            .filter((conv, index, self) =>
              self.findIndex(c => c.id === conv.id) === index
            );

          return {
            workspaceConversations: wsConv,
            conversations: deduplicatedConversations,
            activeConversationId:
              s.activeConversationId === pendingConversationId ? newConvState.conversation.id : s.activeConversationId,
            activeConversationState:
              s.activeConversationId === pendingConversationId || s.activeConversationState?.conversation.id === pendingConversationId
                ? {
                    ...newConvState,
                    config_options: newConvState.config_options ?? [],
                    // Keep showing Initializing until the turn starts Running
                    // (the real runtime state from backend is Ready/Hot/Idle = Connected,
                    //  but we don't want a brief Connected flash before Running)
                    runtime: {
                      ...newConvState.runtime,
                      connection_phase: 'initializing' as const,
                      session_phase: 'cold' as const,
                    },
                  }
                : s.activeConversationState,
            activeTimeline: s.activeTimeline
              ? {
                  ...s.activeTimeline,
                  messages: s.activeTimeline.messages.map((message) =>
                    message.conversation_id === pendingConversationId
                      ? { ...message, conversation_id: newConvState.conversation.id }
                      : message
                  ),
                }
              : s.activeTimeline,
            activeTimelineItems: s.activeTimelineItems.map((item) =>
              item.type === 'message' && item.data.conversation_id === pendingConversationId
                ? {
                    ...item,
                    data: { ...item.data, conversation_id: newConvState.conversation.id },
                  }
                : item
            ),
          };
        });
      } catch (err: any) {
        console.error('Failed to create conversation', err.code ? err : err);
        set((s) => {
          const wsConv = new Map(s.workspaceConversations);
          const convs = wsConv.get(activeWsId) ?? [];
          wsConv.set(activeWsId, convs.map((conversation) =>
            conversation.id === pendingConversationId ? { ...conversation, status: 'failed' } : conversation
          ));
          return {
            workspaceConversations: wsConv,
            conversations: s.conversations.map((conversation) =>
              conversation.id === pendingConversationId ? { ...conversation, status: 'failed' } : conversation
            ),
            activeConversationState:
              s.activeConversationState?.conversation.id === pendingConversationId
                ? {
                    ...s.activeConversationState,
                    runtime: {
                      ...s.activeConversationState.runtime,
                      turn_phase: 'failed',
                      last_error: 'Failed to initialize connection.',
                      last_transition_at: new Date().toISOString(),
                    },
                    conversation: { ...s.activeConversationState.conversation, status: 'failed' },
                  }
                : s.activeConversationState,
            activeTimeline: s.activeTimeline
              ? {
                  ...s.activeTimeline,
                  messages: [
                    ...s.activeTimeline.messages,
                    {
                      id: `local-error-${pendingConversationId}`,
                      conversation_id: pendingConversationId!,
                      turn_id: `local-turn-${pendingConversationId}`,
                      role: 'system',
                      kind: 'error',
                      content_json: { message: 'Failed to initialize connection.' },
                      created_at: new Date().toISOString(),
                    },
                  ],
                }
              : s.activeTimeline,
            activeTimelineItems: s.activeTimelineItems,
          };
        });
        throw err;
      }
    }

    try {
      // Optimistically mark the turn as running so the UI never flashes
      // "Connected" before the backend has transitioned its runtime state.
      if (conversationId) {
        set((s) => ({
          activeConversationState:
            s.activeConversationId === conversationId && s.activeConversationState
              ? {
                  ...s.activeConversationState,
                  runtime: {
                    ...s.activeConversationState.runtime,
                    turn_phase: 'running',
                    last_transition_at: new Date().toISOString(),
                  },
                }
              : s.activeConversationState,
        }));
      }

      const updatedTimeline = await API.sendUserMessage({
        conversation_id: conversationId,
        text,
        attachments,
      });

      if (conversationId) {
        set((s) => ({
          activeTimeline:
            s.activeConversationId === conversationId ? updatedTimeline : s.activeTimeline,
          activeTimelineItems:
            s.activeConversationId === conversationId
              ? mergeTimelineItems(s.activeTimelineItems, updatedTimeline)
              : s.activeTimelineItems,
        }));
        startConversationSync(conversationId, set, get);
      }
    } catch (err: any) {
      console.error('Failed to send message', err.code ? err : err);
      set((s) => ({
        activeConversationState:
          s.activeConversationState?.conversation.id === conversationId
            ? {
                ...s.activeConversationState,
                conversation: { ...s.activeConversationState.conversation, status: 'failed' },
              }
            : s.activeConversationState,
      }));
      throw err;
    }
  },

  deleteConversation: async (conversationId: string) => {
    const targetWorkspaceId =
      findConversationAcrossWorkspaces(get().workspaceConversations, conversationId)?.workspaceId
      ?? get().activeWorkspace?.id;
    if (conversationId.startsWith('local-conversation-')) {
      set((state) => {
        const newWorkspaceConversations = new Map(state.workspaceConversations);
        if (targetWorkspaceId) {
          const convs = newWorkspaceConversations.get(targetWorkspaceId) ?? [];
          newWorkspaceConversations.set(targetWorkspaceId, convs.filter((c) => c.id !== conversationId));
        }
        const nextConversations =
          state.activeWorkspace?.id === targetWorkspaceId
            ? state.conversations.filter((c) => c.id !== conversationId)
            : state.conversations;
        const isActive = state.activeConversationId === conversationId;
        return {
          workspaceConversations: newWorkspaceConversations,
          conversations: nextConversations,
          activeConversationId: isActive ? null : state.activeConversationId,
          activeConversationState: isActive ? null : state.activeConversationState,
          activeTimeline: isActive ? null : state.activeTimeline,
          activeTimelineItems: isActive ? [] : state.activeTimelineItems,
        };
      });
      return;
    }
    try {
      await API.deleteConversation(conversationId);
      set((state) => {
        const newWorkspaceConversations = new Map(state.workspaceConversations);
        if (targetWorkspaceId) {
          const convs = newWorkspaceConversations.get(targetWorkspaceId) ?? [];
          newWorkspaceConversations.set(targetWorkspaceId, convs.filter((c) => c.id !== conversationId));
        }
        const nextConversations =
          state.activeWorkspace?.id === targetWorkspaceId
            ? state.conversations.filter((c) => c.id !== conversationId)
            : state.conversations;
        const isActive = state.activeConversationId === conversationId;
        return {
          workspaceConversations: newWorkspaceConversations,
          conversations: nextConversations,
          activeConversationId: isActive ? null : state.activeConversationId,
          activeConversationState: isActive ? null : state.activeConversationState,
          activeTimeline: isActive ? null : state.activeTimeline,
          activeTimelineItems: isActive ? [] : state.activeTimelineItems,
        };
      });
    } catch (error) {
      console.error('Failed to delete conversation', error);
    }
  },

  setSessionConfig: async (configId: string, value: any) => {
    const state = get();
    if (!state.activeConversationId) return;

    // Check if this is a model change:
    // 1. If models field exists (new adapter), use setModel API directly
    // 2. Otherwise check config_options for model category
    const availableModels = state.activeConversationState?.models?.available_models;
    const hasModels = availableModels && availableModels.length > 0;
    const isModelConfigId = configId.toLowerCase().includes('model');
    const modelOption = state.activeConversationState?.config_options.find(
      (opt) => opt.id === configId && (opt.category?.toLowerCase() === 'model' || opt.id.toLowerCase().includes('model'))
    );

    if (hasModels && isModelConfigId) {
      // Use setModel API for model switching (new adapter style)
      try {
        const models = await API.setModel({
          conversation_id: state.activeConversationId,
          model_id: String(value),
        });
        set((s) => {
          if (s.activeConversationState?.conversation.id === state.activeConversationId) {
            return {
              activeConversationState: {
                ...s.activeConversationState,
                models: models,
              },
            };
          }
          return {};
        });
      } catch (error) {
        console.error('Failed to set model', error);
        throw error;
      }
    } else if (modelOption) {
      // Use setModel API for model switching (old adapter with config_options)
      try {
        const models = await API.setModel({
          conversation_id: state.activeConversationId,
          model_id: String(value),
        });
        set((s) => {
          if (s.activeConversationState?.conversation.id === state.activeConversationId) {
            return {
              activeConversationState: {
                ...s.activeConversationState,
                models: models,
              },
            };
          }
          return {};
        });
      } catch (error) {
        console.error('Failed to set model', error);
        throw error;
      }
    } else {
      // Use setSessionConfig for other config options
      try {
        const configOptions = await API.setSessionConfig({
          conversation_id: state.activeConversationId,
          config_id: configId,
          value,
        });
        set((s) => {
          if (s.activeConversationState?.conversation.id === state.activeConversationId) {
            return {
              activeConversationState: {
                ...s.activeConversationState,
                config_options: configOptions,
              },
            };
          }
          return {};
        });
      } catch (error) {
        console.error('Failed to set session config', error);
        throw error;
      }
    }
  },

  setModel: async (modelId: string) => {
    const state = get();
    if (!state.activeConversationId) return;
    try {
      const models = await API.setModel({
        conversation_id: state.activeConversationId,
        model_id: modelId,
      });
      set((s) => {
        if (s.activeConversationState?.conversation.id === state.activeConversationId) {
          return {
            activeConversationState: {
              ...s.activeConversationState,
              models: models,
            },
          };
        }
        return {};
      });
    } catch (error) {
      console.error('Failed to set model', error);
      throw error;
    }
  },

  setMode: async (modeId: string) => {
    const state = get();
    if (!state.activeConversationId) return;
    try {
      const modes = await API.setMode({
        conversation_id: state.activeConversationId,
        mode_id: modeId,
      });
      set((s) => {
        if (s.activeConversationState?.conversation.id === state.activeConversationId) {
          return {
            activeConversationState: {
              ...s.activeConversationState,
              modes: modes,
            },
          };
        }
        return {};
      });
    } catch (error) {
      console.error('Failed to set mode', error);
      throw error;
    }
  },

  cancelTurn: async () => {
    const state = get();
    const conversationId = state.activeConversationId;
    if (!conversationId) return;
    try {
      set((s) => ({
        activeConversationState: s.activeConversationState
          ? {
              ...s.activeConversationState,
              runtime: {
                ...s.activeConversationState.runtime,
                turn_phase: 'cancelling',
                last_transition_at: new Date().toISOString(),
              },
            }
          : null,
      }));
      await API.cancelTurn(conversationId);
    } catch (error) {
      console.error('Failed to cancel turn', error);
    }
  },

  switchWorkspace: async (workspace: Types.Workspace) => {
    try {
      const currentWorkspace = get().activeWorkspace;

      // If switching to the same workspace, do nothing
      if (currentWorkspace?.id === workspace.id) return;

      // Bootstrap the new workspace
      const bootstrapData = await API.bootstrapWorkspace({
        workspace_id: workspace.id,
      });

      // Update workspaceConversations Map
      const workspaceConversations = new Map(get().workspaceConversations);
      workspaceConversations.set(workspace.id, bootstrapData.conversations);

      // Check if this is a new workspace not in the list
      const existingWorkspaces = get().workspaces;
      const isNewWorkspace = !existingWorkspaces.find(w => w.id === workspace.id);
      const nextWorkspaces = isNewWorkspace ? [...existingWorkspaces, workspace] : existingWorkspaces;

      // 保留用户之前选择的 Agent（如果在新工作区中存在）
      const sortedProfiles = getSortedAgentProfiles(bootstrapData.agent_profiles);
      const prevAgentProfileId = get().activeAgentProfileId;
      const prevAgentExists = sortedProfiles.some(p => p.id === prevAgentProfileId);
      const nextActiveAgentProfileId = prevAgentExists
        ? prevAgentProfileId
        : (sortedProfiles.length > 0 ? sortedProfiles[0].id : null);

      set({
        workspaces: nextWorkspaces,
        activeWorkspace: bootstrapData.workspace,
        workspaceConversations,
        conversations: bootstrapData.conversations,
        agentProfiles: sortedProfiles,
        discoveredSessions: bootstrapData.discovered_sessions,
        mcpServers: bootstrapData.mcp,
        mcpStatuses: new Map(),
        skills: bootstrapData.skills,
        activeAgentProfileId: nextActiveAgentProfileId,
        activeConversationId: null,
        activeConversationState: null,
        activeTimeline: null,
        activeTimelineItems: [],
      });

      // Refresh MCP connection status for the new workspace
      void get().getMcpConnectionStatus();
    } catch (error) {
      console.error('Failed to switch workspace', error);
    }
  },

  pickWorkspace: async () => {
    try {
      const workspace = await API.pickWorkspaceDirectory();
      if (workspace) {
        await get().switchWorkspace(workspace);
      }
      return workspace;
    } catch (error) {
      console.error('Failed to pick workspace', error);
      return null;
    }
  },

  refreshWorkspaces: async () => {
    try {
      const workspaces = await API.listWorkspaces();
      set({ workspaces });
    } catch (error) {
      console.error('Failed to refresh workspaces', error);
    }
  },

  archiveWorkspace: async (workspaceId: string) => {
    try {
      await API.archiveWorkspace(workspaceId);
      set((state) => {
        const nextWorkspaces = state.workspaces.filter(w => w.id !== workspaceId);
        const isActiveWorkspace = state.activeWorkspace?.id === workspaceId;

        // If archiving the active workspace, clear related state
        if (isActiveWorkspace) {
          return {
            workspaces: nextWorkspaces,
            activeWorkspace: null,
            activeConversationId: null,
            activeConversationState: null,
            activeTimeline: null,
            activeTimelineItems: [],
          };
        }
        return { workspaces: nextWorkspaces };
      });
    } catch (error) {
      console.error('Failed to archive workspace', error);
    }
  },

  setAlwaysExpandThinking: (value: boolean) => {
    writeSettingsStorage({ alwaysExpandThinking: value });
    set({ alwaysExpandThinking: value });
  },

  setShowAgentIconInList: (value: boolean) => {
    writeSettingsStorage({ showAgentIconInList: value });
    set({ showAgentIconInList: value });
  },

  setWebuiEnabled: async (value: boolean) => {
    let generatedPassword: string | null = null;
    if (IS_TAURI) {
      try {
        generatedPassword = await API.setWebuiEnabled(value);
      } catch (error) {
        console.error('Failed to set WebUI setting', error);
        throw error;
      }
    }
    // If enabling, fetch or use the generated password; if disabling, clear it
    let webuiPassword: string | null = null;
    let webuiInfo: { port: number; urls: string[] } | null = null;
    if (value) {
      webuiPassword = generatedPassword ?? await API.getWebuiPassword();
      webuiInfo = await API.getWebuiInfo();
    }
    set({ webuiEnabled: value, webuiPassword, webuiInfo });
    return generatedPassword;
  },

  refreshMcpServers: async () => {
    const activeWorkspaceId = get().activeWorkspace?.id;
    if (!activeWorkspaceId) return;
    try {
      const mcpServers = await API.listWorkspaceMcp(activeWorkspaceId);
      set({ mcpServers });
    } catch (error) {
      console.error('Failed to refresh MCP servers', error);
    }
  },

  upsertMcpServer: async (config: Types.McpServerConfig) => {
    try {
      const result = await API.upsertWorkspaceMcp(config);
      set((state) => {
        const existing = state.mcpServers.find(s => s.id === result.id);
        if (existing) {
          return {
            mcpServers: state.mcpServers.map(s => s.id === result.id ? result : s),
          };
        } else {
          return {
            mcpServers: [...state.mcpServers, result],
          };
        }
      });
    } catch (error) {
      console.error('Failed to upsert MCP server', error);
      throw error;
    }
  },

  deleteMcpServer: async (id: string) => {
    try {
      await API.deleteWorkspaceMcp(id);
      set((state) => ({
        mcpServers: state.mcpServers.filter(s => s.id !== id),
      }));
    } catch (error) {
      console.error('Failed to delete MCP server', error);
      throw error;
    }
  },

  testMcpConnection: async (config: Types.McpServerConfig): Promise<Types.McpServerStatus> => {
    return API.testMcpConnection(config);
  },

  importMcpConfigs: async (jsonString: string): Promise<void> => {
    const activeWorkspaceId = get().activeWorkspace?.id;
    if (!activeWorkspaceId) return;
    const imported = await API.importMcpConfigs(activeWorkspaceId, jsonString);
    set((state) => ({
      mcpServers: [...state.mcpServers, ...imported],
    }));
  },

  reloadMcpConnection: async (config: Types.McpServerConfig): Promise<void> => {
    try {
      await API.reloadMcpConnection(config);
    } catch (error) {
      console.error('Failed to reload MCP connection', error);
      throw error;
    }
  },

  reloadAllMcpConnections: async (): Promise<void> => {
    const activeWorkspaceId = get().activeWorkspace?.id;
    if (!activeWorkspaceId) return;
    // Optimistic update: mark all enabled servers as 'connecting'
    set((state) => {
      const next = new Map(state.mcpStatuses);
      for (const server of state.mcpServers) {
        if (server.enabled && server.workspaceId === activeWorkspaceId) {
          const existing = next.get(server.id);
          next.set(server.id, {
            config_id: server.id,
            name: server.name,
            status: 'connecting',
            tools: existing?.tools ?? [],
            resources: existing?.resources ?? [],
            prompts: existing?.prompts ?? [],
            error_message: null,
            server_info: existing?.server_info ?? null,
            last_updated: new Date().toISOString(),
          });
        }
      }
      return { mcpStatuses: next };
    });
    try {
      await API.reloadAllMcpConnections(activeWorkspaceId);
    } catch (error) {
      console.error('Failed to reload all MCP connections', error);
      throw error;
    }
  },

  getMcpConnectionStatus: async (): Promise<Types.McpServerStatus[]> => {
    const activeWorkspaceId = get().activeWorkspace?.id;
    if (!activeWorkspaceId) return [];
    try {
      const statuses = await API.getMcpConnectionStatus(activeWorkspaceId);
      const map = new Map<string, Types.McpServerStatus>();
      statuses.forEach((s) => map.set(s.config_id, s));
      set({ mcpStatuses: map });
      return statuses;
    } catch (error) {
      console.error('Failed to get MCP connection status', error);
      return [];
    }
  },

  updateMcpStatus: (workspaceId: string, status: Types.McpServerStatus) => {
    set((state) => {
      const next = new Map(state.mcpStatuses);
      next.set(status.config_id, status);
      return { mcpStatuses: next };
    });
  },

  clearMcpStatuses: () => {
    set({ mcpStatuses: new Map() });
  },

  // Browser Use Actions
  startBrowser: async (configOverrides?: Partial<Types.BrowserSessionConfig>) => {
    try {
      const baseConfig = get().browserConfig || {
        enabled: true,
        headless: true,
        viewport_width: 1280,
        viewport_height: 720,
        screenshot_interval_ms: 1000,
      };
      const config = { ...baseConfig, ...configOverrides, enabled: true };
      set({ browserStatus: { state: 'starting' } });
      const status = await API.startBrowserSession(config);
      set({ browserStatus: status });
    } catch (error) {
      console.error('Failed to start browser', error);
      set({ browserStatus: { state: 'error', error: String(error) } });
      throw error;
    }
  },

  stopBrowser: async () => {
    try {
      await API.stopBrowserSession();
      set({ browserStatus: { state: 'stopped' }, browserScreenshot: null, browserUrl: null });
    } catch (error) {
      console.error('Failed to stop browser', error);
      throw error;
    }
  },

  refreshBrowserStatus: async () => {
    try {
      const status = await API.getBrowserStatus();
      set({ browserStatus: status });
    } catch (error) {
      console.error('Failed to refresh browser status', error);
    }
  },

  loadBrowserConfig: async (workspaceId: string) => {
    try {
      const config = await API.getBrowserConfig(workspaceId);
      set({ browserConfig: config });
    } catch (error) {
      console.error('Failed to load browser config', error);
    }
  },

  saveBrowserConfig: async (workspaceId: string, config: Types.BrowserSessionConfig) => {
    try {
      await API.saveBrowserConfig(workspaceId, config);
      set({ browserConfig: config });
    } catch (error) {
      console.error('Failed to save browser config', error);
      throw error;
    }
  },

  navigateBrowser: async (url: string) => {
    try {
      set({ browserNavigating: true, browserUrl: url });
      await API.navigateBrowser(url);
    } catch (error) {
      console.error('Failed to navigate browser', error);
      set({ browserNavigating: false });
      throw error;
    }
  },

  browserReload: async () => {
    try {
      await API.browserReload();
    } catch (error) {
      console.error('Failed to reload browser', error);
      throw error;
    }
  },

  browserGoBack: async () => {
    try {
      await API.browserGoBack();
    } catch (error) {
      console.error('Failed to go back', error);
      throw error;
    }
  },

  browserGoForward: async () => {
    try {
      await API.browserGoForward();
    } catch (error) {
      console.error('Failed to go forward', error);
      throw error;
    }
  },

  login: async (password: string) => {
    const success = await apiLogin(password);
    if (success) {
      set({ isAuthenticated: true });
      await get().init();
    }
    return success;
  },

  logout: async () => {
    // Clean up event listeners before logout
    get()._teardownEventSubscriptions();
    await apiLogout();
    set({
      isAuthenticated: false,
      hasEventSubscriptions: false,
      workspaces: [],
      activeWorkspace: null,
      conversations: [],
      activeConversationId: null,
      activeConversationState: null,
      activeTimeline: null,
      activeTimelineItems: [],
    });
  },

  _setupEventSubscriptions: () => {
    if (get().hasEventSubscriptions) return;
    set({ hasEventSubscriptions: true });

    // Store unlisten functions for cleanup
    void (async () => {
      const unlistens: UnlistenFn[] = [];

      unlistens.push(await Events.onConversationMessageAppended((payload) => {
        set((state) => {
          if (state.activeConversationId !== payload.conversation_id || !state.activeTimeline) return state;
          return {
            activeTimeline: mergeTimelineMessage(state.activeTimeline, payload.message),
            activeTimelineItems: upsertTimelineItem(state.activeTimelineItems, {
              type: 'message',
              key: timelineItemKey('message', payload.message.id),
              data: payload.message,
            }),
          };
        });
      }));

      unlistens.push(await Events.onConversationMessageUpdated((payload) => {
        set((state) => {
          if (state.activeConversationId !== payload.conversation_id || !state.activeTimeline) return state;
          return {
            activeTimeline: mergeTimelineMessage(state.activeTimeline, payload.message),
            activeTimelineItems: upsertTimelineItem(state.activeTimelineItems, {
              type: 'message',
              key: timelineItemKey('message', payload.message.id),
              data: payload.message,
            }),
          };
        });
      }));

      unlistens.push(await Events.onConversationTerminalOutput((payload) => {
        set((state) => {
          if (state.activeConversationId !== payload.conversation_id || !state.activeTimeline) return state;
          if (payload.terminal) {
            return {
              activeTimeline: mergeTerminal(state.activeTimeline, payload.terminal),
            };
          }
          return state;
        });
      }));

    unlistens.push(await Events.onConversationStateChanged((payload) => {
        const activeWsId = get().activeWorkspace?.id;
        const isActiveConv = get().activeConversationId === payload.conversation_id;
        const currentRunning = get().runningConversations;
        const wasRunning = currentRunning.has(payload.conversation_id);
        const isNowIdle = payload.state.runtime.turn_phase === 'idle';
        const isNowRunning = payload.state.runtime.turn_phase === 'running';

        set((state) => {
          const newWorkspaceConversations = new Map(state.workspaceConversations);
          const targetWsId = payload.state.conversation.workspace_id;
          const currentConvs = newWorkspaceConversations.get(targetWsId) ?? [];

          let found = false;
          let updatedConvs = currentConvs.map(c => {
            if (c.id === payload.conversation_id) {
              found = true;
              return payload.state.conversation;
            }
            return c;
          });

          if (!found) {
            updatedConvs = [payload.state.conversation, ...currentConvs];
          }
          // Keep conversations sorted by updated_at descending
          updatedConvs.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
          newWorkspaceConversations.set(targetWsId, updatedConvs);

          const isTargetActiveWs = state.activeWorkspace?.id === targetWsId;
          const updatedConversations = isTargetActiveWs ? updatedConvs : state.conversations;

          // Track running conversations and detect completion
          const nextRunning = new Set(state.runningConversations);
          const nextUnread = new Set(state.unreadCompletedConversations);

          if (isNowRunning) {
            nextRunning.add(payload.conversation_id);
          } else if (isNowIdle && wasRunning) {
            // Conversation just completed - mark as unread if user not viewing
            nextRunning.delete(payload.conversation_id);
            if (!isActiveConv) {
              nextUnread.add(payload.conversation_id);
            }
          }

          // Preserve model/mode metadata if a state refresh omits unstable ACP fields.
          let newState = payload.state;
          const currentModels = state.activeConversationState?.models;
          const currentAvailableModels = currentModels?.available_models;
          const currentModes = state.activeConversationState?.modes;
          const currentAvailableModes = currentModes?.available_modes;
          if (state.activeConversationId === payload.conversation_id) {
            const payloadAvailableModels = payload.state.models?.available_models;
            const payloadAvailableModes = payload.state.modes?.available_modes;
            if (currentAvailableModels && currentAvailableModels.length > 0 &&
                (!payloadAvailableModels || payloadAvailableModels.length === 0)) {
              newState = {
                ...newState,
                models: currentModels,
              };
            }
            if (currentAvailableModes && currentAvailableModes.length > 0 &&
                (!payloadAvailableModes || payloadAvailableModes.length === 0)) {
              newState = {
                ...newState,
                modes: currentModes,
              };
            }
          }

          return {
            workspaceConversations: newWorkspaceConversations,
            conversations: updatedConversations,
            runningConversations: nextRunning,
            unreadCompletedConversations: nextUnread,
            activeConversationState: state.activeConversationId === payload.conversation_id
              ? newState
              : state.activeConversationState,
            activeAgentProfileId: state.activeConversationId === payload.conversation_id
              ? payload.state.conversation.agent_profile_id
              : state.activeAgentProfileId,
          };
        });
        if (get().activeConversationId === payload.conversation_id && isConversationActive(payload.state)) {
          startConversationSync(payload.conversation_id, set, get);
        }
      }));

      unlistens.push(await Events.onAgentProfileProbed((payload) => {
        set((state) => ({
          agentProfiles: state.agentProfiles.map((profile) =>
            profile.id === payload.profile_id
              ? { ...profile, capabilities_cache: payload.capabilities }
              : profile
          ),
        }));
      }));

      unlistens.push(await Events.onConversationConfigUpdated((payload) => {
        set((state) => {
          if (state.activeConversationId === payload.conversation_id && state.activeConversationState) {
            const updates: Partial<Types.ConversationState> = {};
            if (payload.config_options) {
              updates.config_options = payload.config_options;
            }
            if (payload.models) {
              updates.models = payload.models;
            }
            if (payload.modes) {
              updates.modes = payload.modes;
            }
            if (Object.keys(updates).length > 0) {
              return {
                activeConversationState: {
                  ...state.activeConversationState,
                  ...updates,
                },
              };
            }
          }
          return {};
        });
      }));

      unlistens.push(await Events.onConversationCommandsUpdated((payload) => {
        set((state) => {
          if (state.activeConversationId === payload.conversation_id && state.activeConversationState) {
            return {
              activeConversationState: {
                ...state.activeConversationState,
                available_commands: payload.available_commands,
              },
            };
          }
          return {};
        });
      }));

      unlistens.push(await Events.onConversationDeleted((payload) => {
        const activeWsId = get().activeWorkspace?.id;
        set((state) => {
          const newWorkspaceConversations = new Map(state.workspaceConversations);
          if (activeWsId) {
            const convs = newWorkspaceConversations.get(activeWsId) ?? [];
            newWorkspaceConversations.set(activeWsId, convs.filter((c) => c.id !== payload.conversation_id));
          }
          const nextConversations = state.conversations.filter((c) => c.id !== payload.conversation_id);
          const isActive = state.activeConversationId === payload.conversation_id;
          const nextUnread = new Set(state.unreadCompletedConversations);
          nextUnread.delete(payload.conversation_id);
          const nextRunning = new Set(state.runningConversations);
          nextRunning.delete(payload.conversation_id);
          return {
            workspaceConversations: newWorkspaceConversations,
            conversations: nextConversations,
            unreadCompletedConversations: nextUnread,
            runningConversations: nextRunning,
            activeConversationId: isActive ? null : state.activeConversationId,
            activeConversationState: isActive ? null : state.activeConversationState,
            activeTimeline: isActive ? null : state.activeTimeline,
            activeTimelineItems: isActive ? [] : state.activeTimelineItems,
          };
        });
      }));

      unlistens.push(await Events.onConversationToolCallChanged((payload) => {
        set((state) => {
          if (state.activeConversationId !== payload.conversation_id || !state.activeTimeline) return state;
          return {
            activeTimeline: mergeToolCall(state.activeTimeline, payload.tool_call),
            activeTimelineItems: upsertTimelineItem(state.activeTimelineItems, {
              type: 'tool_call',
              key: timelineItemKey('tool_call', payload.tool_call.tool_call_id || payload.tool_call.id),
              data: payload.tool_call,
            }),
          };
        });
      }));

      unlistens.push(await Events.onConversationPermissionRequested((payload) => {
        set((state) => {
          if (state.activeConversationId !== payload.conversation_id) return state;
          return {
            activeTimeline: state.activeTimeline
              ? {
                  ...state.activeTimeline,
                  pending_permissions: mergePendingPermission(state.activeTimeline.pending_permissions, payload.request),
                }
              : state.activeTimeline,
            activeTimelineItems: upsertTimelineItem(state.activeTimelineItems, {
              type: 'permission',
              key: timelineItemKey('permission', payload.request.id),
              data: payload.request,
            }),
            activeConversationState: state.activeConversationState
              ? {
                  ...state.activeConversationState,
                  pending_permissions: mergePendingPermission(state.activeConversationState.pending_permissions, payload.request),
                }
              : state.activeConversationState,
          };
        });
      }));

      unlistens.push(await Events.onConversationPermissionResolved((payload) => {
        set((state) => {
          if (state.activeConversationId !== payload.conversation_id) return state;
          const markResolved = (requests: Types.PendingPermissionRequest[]) =>
            requests.map((request) =>
              request.tool_call_id === payload.decision.tool_call_id
                ? {
                    ...request,
                    status: 'resolved' as const,
                    resolved_at: payload.decision.created_at,
                  }
                : request,
            );
          return {
            activeTimeline: state.activeTimeline
              ? {
                  ...state.activeTimeline,
                  pending_permissions: markResolved(state.activeTimeline.pending_permissions),
                }
              : state.activeTimeline,
            activeTimelineItems: state.activeTimelineItems.map((item) =>
              item.type === 'permission' && item.data.tool_call_id === payload.decision.tool_call_id
                ? {
                    ...item,
                    data: {
                      ...item.data,
                      status: 'resolved',
                      resolved_at: payload.decision.created_at,
                    },
                  }
                : item
            ),
            activeConversationState: state.activeConversationState
              ? {
                  ...state.activeConversationState,
                  pending_permissions: markResolved(state.activeConversationState.pending_permissions),
                }
              : state.activeConversationState,
          };
        });
      }));

      unlistens.push(await Events.onConversationTurnFinished((payload) => {
        if (get().activeConversationId === payload.conversation_id) {
          void refreshActiveConversation(payload.conversation_id, set, get);
        }
      }));

      unlistens.push(await Events.onTaskRunStateChanged((payload) => {
        set((state) => {
          if (state.activeConversationId !== payload.conversation_id || !state.activeConversationState) {
            return state;
          }
          return {
            activeConversationState: {
              ...state.activeConversationState,
              task_run: payload.task_run,
            },
          };
        });
      }));

      // Browser screenshot event subscription
      unlistens.push(await Events.onBrowserScreenshot((payload) => {
        set({
          browserScreenshot: payload.base64_png,
          browserUrl: payload.url ?? null,
          browserNavigating: false,
        });
      }));

      // Browser state changed event subscription
      unlistens.push(await Events.onBrowserStateChanged((payload) => {
        set({
          browserStatus: {
            ...get().browserStatus,
            state: payload.state,
            current_url: payload.current_url ?? null,
            page_title: payload.page_title ?? null,
            cdp_port: payload.cdp_port ?? null,
          },
          browserUrl: payload.current_url ?? get().browserUrl,
          browserPageTitle: payload.page_title ?? null,
          browserNavigating: false,
        });

        // Delayed refresh of MCP list so the proxy has time to start/stop
        setTimeout(() => {
          get().refreshMcpServers();
          get().getMcpConnectionStatus();
        }, 800);
      }));

      // MCP status changed event subscription
      unlistens.push(await Events.onMcpStatusChanged((payload) => {
        if (payload.workspace_id === get().activeWorkspace?.id) {
          get().updateMcpStatus(payload.workspace_id, payload.status);
        }
      }));

      // MCP list changed event subscription (e.g. browser MCP toggle/start/stop)
      unlistens.push(await Events.onMcpListChanged(() => {
        get().refreshMcpServers();
      }));

      // Store all unlisten functions for cleanup
      eventUnlisteners = unlistens;
    })();
  },

  _teardownEventSubscriptions: () => {
    // Clean up all event listeners
    eventUnlisteners.forEach((fn) => fn());
    eventUnlisteners = [];
    set({ hasEventSubscriptions: false });
  }
}));

// Subscribe to auth state updates
if (typeof window !== 'undefined') {
  subscribeAuthState((isAuthenticated) => {
    const store = useAppStore.getState();
    if (store && store.isAuthenticated !== isAuthenticated) {
      useAppStore.setState({ isAuthenticated });
    }
  });
}
