import { create } from 'zustand';
import type * as Types from './backend/types';
import * as API from './backend/commands';
import * as Events from './backend/events';

let activeTurnSyncToken = 0;

export type TimelineItem =
  | { type: 'message'; key: string; data: Types.MessageProjection }
  | { type: 'tool_call'; key: string; data: Types.ToolCallProjection }
  | { type: 'permission'; key: string; data: Types.PendingPermissionRequest };

function buildConversationTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Untitled Chat';
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 60).trimEnd()}...`;
}

function isConversationActive(state: Types.ConversationState | null): boolean {
  if (!state) return false;
  return state.runtime.session_phase === 'loading'
    || state.runtime.turn_phase === 'running'
    || state.runtime.turn_phase === 'cancelling'
    || state.runtime.turn_phase === 'failed';
}

function compareIsoTimestamp(a?: string | null, b?: string | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;

  const aMillis = Date.parse(a);
  const bMillis = Date.parse(b);
  if (aMillis !== bMillis) return aMillis - bMillis;

  const aFraction = (a.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] ?? '').padEnd(9, '0').slice(0, 9);
  const bFraction = (b.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] ?? '').padEnd(9, '0').slice(0, 9);
  if (aFraction !== bFraction) return aFraction.localeCompare(bFraction);

  return a.localeCompare(b);
}

function sortMessages(messages: Types.MessageProjection[]): Types.MessageProjection[] {
  return [...messages].sort((a, b) => compareIsoTimestamp(a.created_at, b.created_at));
}

function timelineItemKey(type: TimelineItem['type'], id: string): string {
  return `${type}:${id}`;
}

function buildTimelineItems(timeline: Types.TimelineResponse): TimelineItem[] {
  const items: Array<TimelineItem & { ts: string }> = [
    ...timeline.messages.map((message) => ({
      type: 'message' as const,
      key: timelineItemKey('message', message.id),
      data: message,
      ts: message.created_at,
    })),
    ...timeline.tool_calls.map((toolCall) => ({
      type: 'tool_call' as const,
      key: timelineItemKey('tool_call', toolCall.tool_call_id || toolCall.id),
      data: toolCall,
      ts: toolCall.started_at,
    })),
    ...timeline.pending_permissions.map((request) => ({
      type: 'permission' as const,
      key: timelineItemKey('permission', request.id),
      data: request,
      ts: request.created_at,
    })),
  ];

  return items
    .sort((a, b) => {
      const timeDiff = compareIsoTimestamp(a.ts, b.ts);
      if (timeDiff !== 0) return timeDiff;
      return a.key.localeCompare(b.key);
    })
    .map(({ ts: _ts, ...item }) => item);
}

function upsertTimelineItem(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const existingIndex = items.findIndex((entry) => entry.key === item.key);
  if (existingIndex >= 0) {
    return items.map((entry, index) => (index === existingIndex ? item : entry));
  }
  return [...items, item];
}

function mergeTimelineItems(items: TimelineItem[], timeline: Types.TimelineResponse): TimelineItem[] {
  return buildTimelineItems(timeline).reduce((next, item) => upsertTimelineItem(next, item), items);
}

function mergeTimelineMessage(
  timeline: Types.TimelineResponse,
  message: Types.MessageProjection,
): Types.TimelineResponse {
  const existingIndex = timeline.messages.findIndex((item) => item.id === message.id);
  const nextMessages =
    existingIndex >= 0
      ? timeline.messages.map((item, index) => (index === existingIndex ? message : item))
      : [...timeline.messages, message];
  return {
    ...timeline,
    messages: sortMessages(nextMessages),
  };
}

function mergeToolCall(
  timeline: Types.TimelineResponse,
  toolCall: Types.ToolCallProjection,
): Types.TimelineResponse {
  const existingIndex = timeline.tool_calls.findIndex(
    (item) => item.tool_call_id === toolCall.tool_call_id || item.id === toolCall.id,
  );
  const nextToolCalls =
    existingIndex >= 0
      ? timeline.tool_calls.map((item, index) => (index === existingIndex ? toolCall : item))
      : [...timeline.tool_calls, toolCall];
  return {
    ...timeline,
    tool_calls: nextToolCalls.sort(
      (a, b) => compareIsoTimestamp(a.started_at, b.started_at),
    ),
  };
}

function mergeTerminal(
  timeline: Types.TimelineResponse,
  terminal: Types.TerminalRecord,
): Types.TimelineResponse {
  const existingIndex = timeline.terminals.findIndex(
    (item) => item.terminal_id === terminal.terminal_id || item.id === terminal.id,
  );
  const nextTerminals =
    existingIndex >= 0
      ? timeline.terminals.map((item, index) => (index === existingIndex ? terminal : item))
      : [...timeline.terminals, terminal];
  return {
    ...timeline,
    terminals: nextTerminals.sort(
      (a, b) => compareIsoTimestamp(a.started_at, b.started_at),
    ),
  };
}

function mergePendingPermission(
  pendingPermissions: Types.PendingPermissionRequest[],
  request: Types.PendingPermissionRequest,
): Types.PendingPermissionRequest[] {
  const existingIndex = pendingPermissions.findIndex(
    (item) => item.id === request.id || item.tool_call_id === request.tool_call_id,
  );
  const nextPendingPermissions =
    existingIndex >= 0
      ? pendingPermissions.map((item, index) => (index === existingIndex ? request : item))
      : [...pendingPermissions, request];
  return nextPendingPermissions.sort(
    (a, b) => compareIsoTimestamp(a.created_at, b.created_at),
  );
}

function findConversationAcrossWorkspaces(
  workspaceConversations: Map<string, Types.Conversation[]>,
  conversationId: string,
): { workspaceId: string; conversation: Types.Conversation } | null {
  for (const [workspaceId, conversations] of workspaceConversations.entries()) {
    const conversation = conversations.find((item) => item.id === conversationId);
    if (conversation) {
      return { workspaceId, conversation };
    }
  }
  return null;
}

function startConversationSync(
  conversationId: string,
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
) {
  const syncToken = ++activeTurnSyncToken;
  void (async () => {
    for (let attempt = 0; attempt < 1200; attempt += 1) {
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
          if (syncToken === activeTurnSyncToken) {
            activeTurnSyncToken += 1;
          }
          return;
        }
      } catch (error) {
        console.error('Failed to sync active conversation', conversationId, error);
      }

      if (get().activeConversationId !== conversationId) {
        return;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 500));
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
  hasEventSubscriptions: boolean;

  // Workspace
  workspaces: Types.Workspace[];
  activeWorkspace: Types.Workspace | null;
  mcpServers: Types.McpServerConfig[];
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

  // Event Handlers
  _setupEventSubscriptions: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  isInitializing: true,
  hasEventSubscriptions: false,

  workspaces: [],
  activeWorkspace: null,
  mcpServers: [],
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

  init: async () => {
    try {
      // 1. Load all workspaces from backend
      const allWorkspaces = await API.listWorkspaces();

      // 2. Get or create the default workspace at ~/.oneagent
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

      set({
        workspaces,
        activeWorkspace: bootstrapData.workspace,
        workspaceConversations,
        conversations: bootstrapData.conversations,
        agentProfiles: bootstrapData.agent_profiles,
        discoveredSessions: bootstrapData.discovered_sessions,
        mcpServers: bootstrapData.mcp,
        skills: bootstrapData.skills,
        activeAgentProfileId: bootstrapData.agent_profiles.length > 0 ? bootstrapData.agent_profiles[0].id : null,
        activeConversationState: null,
        isInitializing: false,
      });

      // 4. Set up event listeners
      get()._setupEventSubscriptions();

      // 5. Refresh agent discovery state in the background
      void Promise.allSettled([API.listAgentProfiles(), API.listAgentDiscoveryStatus()]).then((results) => {
        const [profilesResult, discoveryResult] = results;
        set((state) => {
          const nextProfiles =
            profilesResult.status === 'fulfilled' ? profilesResult.value : state.agentProfiles;
          const nextActiveAgentProfileId =
            state.activeAgentProfileId ?? nextProfiles[0]?.id ?? null;
          return {
            agentProfiles: nextProfiles,
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
    set({
      activeConversationId: id,
      activeAgentProfileId: selectedConversation?.agent_profile_id ?? get().activeAgentProfileId,
      activeConversationState: null,
      activeTimeline: null,
      activeTimelineItems: [],
    });

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

            return {
              activeWorkspace: bootstrapData.workspace,
              workspaceConversations,
              conversations: bootstrapData.conversations,
              agentProfiles: bootstrapData.agent_profiles,
              discoveredSessions: bootstrapData.discovered_sessions,
              mcpServers: bootstrapData.mcp,
              skills: bootstrapData.skills,
              activeAgentProfileId:
                selectedConversation?.agent_profile_id
                ?? bootstrapData.agent_profiles[0]?.id
                ?? state.activeAgentProfileId,
            };
          });
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
    set({ activeAgentProfileId: id });
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
          const updatedConvs = convs.map((conversation) =>
            conversation.id === pendingConversationId ? newConvState.conversation : conversation
          );
          wsConv.set(activeWsId, updatedConvs);
          return {
            workspaceConversations: wsConv,
            conversations: s.conversations.map((conversation) =>
              conversation.id === pendingConversationId ? newConvState.conversation : conversation
            ),
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
      const prevAgentProfileId = get().activeAgentProfileId;
      const prevAgentExists = bootstrapData.agent_profiles.some(p => p.id === prevAgentProfileId);
      const nextActiveAgentProfileId = prevAgentExists
        ? prevAgentProfileId
        : (bootstrapData.agent_profiles.length > 0 ? bootstrapData.agent_profiles[0].id : null);

      set({
        workspaces: nextWorkspaces,
        activeWorkspace: bootstrapData.workspace,
        workspaceConversations,
        conversations: bootstrapData.conversations,
        agentProfiles: bootstrapData.agent_profiles,
        discoveredSessions: bootstrapData.discovered_sessions,
        mcpServers: bootstrapData.mcp,
        skills: bootstrapData.skills,
        activeAgentProfileId: nextActiveAgentProfileId,
        activeConversationId: null,
        activeConversationState: null,
        activeTimeline: null,
        activeTimelineItems: [],
      });
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

  _setupEventSubscriptions: () => {
    if (get().hasEventSubscriptions) return;
    set({ hasEventSubscriptions: true });

    Events.onConversationMessageAppended((payload) => {
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
    });

    Events.onConversationMessageUpdated((payload) => {
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
    });

    Events.onConversationTerminalOutput((payload) => {
      set((state) => {
        if (state.activeConversationId !== payload.conversation_id || !state.activeTimeline) return state;
        if (payload.terminal) {
          return {
            activeTimeline: mergeTerminal(state.activeTimeline, payload.terminal),
          };
        }
        return state;
      });
    });

    Events.onConversationStateChanged((payload) => {
      const activeWsId = get().activeWorkspace?.id;
      set((state) => {
        const newWorkspaceConversations = new Map(state.workspaceConversations);
        // Update in the specific workspace's conversation list
        for (const [wsId, conversations] of newWorkspaceConversations) {
          const updated = conversations.map(c =>
            c.id === payload.conversation_id ? { ...c, status: payload.state.conversation.status } : c
          );
          if (updated.length !== conversations.length || updated.some((c, i) => c.status !== conversations[i].status)) {
            newWorkspaceConversations.set(wsId, updated);
          }
        }
        // Also update current conversations if visible
        const updatedConversations = state.conversations.map(c =>
          c.id === payload.conversation_id ? { ...c, status: payload.state.conversation.status } : c
        );

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
    });

    Events.onAgentProfileProbed((payload) => {
      set((state) => ({
        agentProfiles: state.agentProfiles.map((profile) =>
          profile.id === payload.profile_id
            ? { ...profile, capabilities_cache: payload.capabilities }
            : profile
        ),
      }));
    });

    Events.onConversationConfigUpdated((payload) => {
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
    });

    Events.onConversationDeleted((payload) => {
      const activeWsId = get().activeWorkspace?.id;
      set((state) => {
        const newWorkspaceConversations = new Map(state.workspaceConversations);
        if (activeWsId) {
          const convs = newWorkspaceConversations.get(activeWsId) ?? [];
          newWorkspaceConversations.set(activeWsId, convs.filter((c) => c.id !== payload.conversation_id));
        }
        const nextConversations = state.conversations.filter((c) => c.id !== payload.conversation_id);
        const isActive = state.activeConversationId === payload.conversation_id;
        return {
          workspaceConversations: newWorkspaceConversations,
          conversations: nextConversations,
          activeConversationId: isActive ? null : state.activeConversationId,
          activeConversationState: isActive ? null : state.activeConversationState,
          activeTimeline: isActive ? null : state.activeTimeline,
          activeTimelineItems: isActive ? [] : state.activeTimelineItems,
        };
      });
    });

    Events.onConversationToolCallChanged((payload) => {
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
    });

    Events.onConversationPermissionRequested((payload) => {
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
    });

    Events.onConversationPermissionResolved((payload) => {
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
    });

    Events.onConversationTurnFinished((payload) => {
      if (get().activeConversationId === payload.conversation_id) {
        void refreshActiveConversation(payload.conversation_id, set, get);
      }
    });

    Events.onTaskRunStateChanged((payload) => {
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
    });
  }
}));
