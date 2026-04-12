import { create } from 'zustand';
import type * as Types from './backend/types';
import * as API from './backend/commands';
import * as Events from './backend/events';

let activeTurnSyncToken = 0;

function buildConversationTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Untitled Chat';
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 60).trimEnd()}...`;
}

function isConversationActive(state: Types.ConversationState | null): boolean {
  if (!state) return false;
  return state.conversation.status === 'running' || state.conversation.status === 'starting';
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

    } catch (error) {
      console.error('Failed to initialize app state:', error);
      set({ isInitializing: false });
    }
  },

  selectConversation: async (id: string | null) => {
    activeTurnSyncToken += 1;
    const activeWsId = get().activeWorkspace?.id;
    const currentConversations = activeWsId ? get().workspaceConversations.get(activeWsId) ?? [] : [];
    const selectedConversation = id ? currentConversations.find((conversation) => conversation.id === id) ?? null : null;
    set({
      activeConversationId: id,
      activeAgentProfileId: selectedConversation?.agent_profile_id ?? get().activeAgentProfileId,
      activeConversationState: null,
    });

    if (id) {
      try {
        const [timeline, conversationState] = await Promise.all([
          API.getConversationTimeline(id),
          API.getConversationState(id),
        ]);
        set({ activeTimeline: timeline, activeConversationState: conversationState });

        if (isConversationActive(conversationState)) {
          startConversationSync(id, set, get);
        }
      } catch (error) {
        console.error('Failed to fetch timeline for conversation', id, error);
        set({ activeTimeline: null, activeConversationState: null });
      }
    } else {
      set({ activeTimeline: null, activeConversationState: null });
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
      return null;
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
      const optimisticUserMessage: Types.MessageProjection = {
        id: `local-user-${pendingConversationId}`,
        conversation_id: pendingConversationId,
        turn_id: pendingTurnId,
        role: 'user',
        kind: 'text',
        content_json: { text, attachments },
        created_at: new Date().toISOString(),
      };
      const optimisticStatusMessage: Types.MessageProjection = {
        id: `local-status-${pendingConversationId}`,
        conversation_id: pendingConversationId,
        turn_id: pendingTurnId,
        role: 'system',
        kind: 'status',
        content_json: { message: 'Initializing connection...' },
        created_at: new Date().toISOString(),
      };

      const newWorkspaceConversations = new Map(state.workspaceConversations);
      newWorkspaceConversations.set(activeWsId, [pendingConversation, ...currentConversations]);

      set((s) => ({
        workspaceConversations: newWorkspaceConversations,
        conversations: [pendingConversation, ...s.conversations],
        activeConversationId: pendingConversationId,
        activeConversationState: {
          conversation: pendingConversation,
          binding: null,
          task_run: null,
          config_options: [],
          pending_permissions: [],
        },
        activeTimeline: {
          events: [],
          messages: [optimisticUserMessage, optimisticStatusMessage],
          tool_calls: [],
          pending_permissions: [],
          terminals: [],
        },
      }));
      try {
        let newConvState = await API.createConversation({
          workspace_id: activeWsId,
          agent_profile_id: state.activeAgentProfileId,
          title: pendingConversation.title,
        });
        if (sessionConfigOverrides.length > 0) {
          for (const override of sessionConfigOverrides) {
            await API.setSessionConfig({
              conversation_id: newConvState.conversation.id,
              config_id: override.config_id,
              value: override.value,
            });
          }
          newConvState = await API.getConversationState(newConvState.conversation.id);
        }
        conversationId = newConvState.conversation.id;

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
                ? { ...newConvState, config_options: newConvState.config_options ?? [] }
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
          };
        });
        throw err;
      }
    }

    try {
      if (conversationId) {
        set((s) => ({
          activeConversationState:
            s.activeConversationState?.conversation.id === conversationId
              ? {
                  ...s.activeConversationState,
                  conversation: { ...s.activeConversationState.conversation, status: 'running' },
                }
              : s.activeConversationState,
          activeTimeline: !pendingConversationId && s.activeTimeline && s.activeConversationId === conversationId
            ? {
                ...s.activeTimeline,
                messages: [...s.activeTimeline.messages, {
                  id: `local-user-${Date.now()}`,
                  conversation_id: conversationId,
                  turn_id: `local-turn-${Date.now()}`,
                  role: 'user' as const,
                  kind: 'text' as const,
                  content_json: { text, attachments },
                  created_at: new Date().toISOString(),
                } satisfies Types.MessageProjection].sort((a, b) =>
                  new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
                ),
              }
            : s.activeTimeline,
        }));
      }

      const updatedTimeline = await API.sendUserMessage({
        conversation_id: conversationId,
        text,
        attachments,
      });

      if (conversationId) {
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
    const activeWsId = get().activeWorkspace?.id;
    if (conversationId.startsWith('local-conversation-')) {
      set((state) => {
        const newWorkspaceConversations = new Map(state.workspaceConversations);
        if (activeWsId) {
          const convs = newWorkspaceConversations.get(activeWsId) ?? [];
          newWorkspaceConversations.set(activeWsId, convs.filter((c) => c.id !== conversationId));
        }
        const nextConversations = state.conversations.filter((c) => c.id !== conversationId);
        const isActive = state.activeConversationId === conversationId;
        return {
          workspaceConversations: newWorkspaceConversations,
          conversations: nextConversations,
          activeConversationId: isActive ? null : state.activeConversationId,
          activeConversationState: isActive ? null : state.activeConversationState,
          activeTimeline: isActive ? null : state.activeTimeline,
        };
      });
      return;
    }
    try {
      await API.deleteConversation(conversationId);
      set((state) => {
        const newWorkspaceConversations = new Map(state.workspaceConversations);
        if (activeWsId) {
          const convs = newWorkspaceConversations.get(activeWsId) ?? [];
          newWorkspaceConversations.set(activeWsId, convs.filter((c) => c.id !== conversationId));
        }
        const nextConversations = state.conversations.filter((c) => c.id !== conversationId);
        const isActive = state.activeConversationId === conversationId;
        return {
          workspaceConversations: newWorkspaceConversations,
          conversations: nextConversations,
          activeConversationId: isActive ? null : state.activeConversationId,
          activeConversationState: isActive ? null : state.activeConversationState,
          activeTimeline: isActive ? null : state.activeTimeline,
        };
      });
    } catch (error) {
      console.error('Failed to delete conversation', error);
    }
  },

  setSessionConfig: async (configId: string, value: any) => {
    const state = get();
    if (!state.activeConversationId) return;
    try {
      await API.setSessionConfig({
        conversation_id: state.activeConversationId,
        config_id: configId,
        value,
      });
      const nextState = await API.getConversationState(state.activeConversationId);
      set({ activeConversationState: nextState });
    } catch (error) {
      console.error('Failed to set session config', error);
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

      set({
        workspaces: nextWorkspaces,
        activeWorkspace: bootstrapData.workspace,
        workspaceConversations,
        conversations: bootstrapData.conversations,
        agentProfiles: bootstrapData.agent_profiles,
        discoveredSessions: bootstrapData.discovered_sessions,
        mcpServers: bootstrapData.mcp,
        skills: bootstrapData.skills,
        activeAgentProfileId: bootstrapData.agent_profiles.length > 0 ? bootstrapData.agent_profiles[0].id : null,
        activeConversationId: null,
        activeConversationState: null,
        activeTimeline: null,
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
        };
      });
    });

    Events.onConversationMessageUpdated((payload) => {
      set((state) => {
        if (state.activeConversationId !== payload.conversation_id || !state.activeTimeline) return state;
        return {
          activeTimeline: mergeTimelineMessage(state.activeTimeline, payload.message),
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
        return {
          workspaceConversations: newWorkspaceConversations,
          conversations: updatedConversations,
          activeConversationState: state.activeConversationId === payload.conversation_id
            ? payload.state
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
        };
      });
    });

    Events.onConversationToolCallChanged((payload) => {
      set((state) => {
        if (state.activeConversationId !== payload.conversation_id || !state.activeTimeline) return state;
        return {
          activeTimeline: mergeToolCall(state.activeTimeline, payload.tool_call),
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
