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

function startConversationSync(
  conversationId: string,
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
) {
  const syncToken = ++activeTurnSyncToken;
  void (async () => {
    // Poll for up to 10 minutes (1200 * 500ms)
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

  // Conversations
  conversations: Types.Conversation[];
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
  sendMessage: (text: string, attachments?: Types.AttachmentInput[]) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  setSessionConfig: (configId: string, value: any) => Promise<void>;
  
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

  conversations: [],
  discoveredSessions: [],
  activeConversationId: null,
  activeConversationState: null,
  
  activeTimeline: null,

  init: async () => {
    try {
      // 1. Get initial workspaces
      let workspaces = await API.listWorkspaces();
      
      // If no workspace exists, we might want to default to the current directory
      if (workspaces.length === 0) {
        // Fallback to opening current directory as a workspace
        const newWs = await API.openWorkspace('.');
        workspaces = [newWs];
      }
      
      const activeWorkspace = workspaces[0];
      
      // 2. Call bootstrap workspace
      const bootstrapData = await API.bootstrapWorkspace({
        workspace_id: activeWorkspace.id,
      });

      set({
        workspaces,
        activeWorkspace: bootstrapData.workspace,
        agentProfiles: bootstrapData.agent_profiles,
        conversations: bootstrapData.conversations,
        discoveredSessions: bootstrapData.discovered_sessions,
        mcpServers: bootstrapData.mcp,
        skills: bootstrapData.skills,
        
        // Auto-select the first available agent profile for "New Chat" defaults
        activeAgentProfileId: bootstrapData.agent_profiles.length > 0 ? bootstrapData.agent_profiles[0].id : null,
        activeConversationState: null,
        isInitializing: false,
      });

      // 3. Set up event listeners
      get()._setupEventSubscriptions();

      // 4. Refresh agent discovery state in the background so startup never blocks on ACP probing.
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
    const selectedConversation = id ? get().conversations.find((conversation) => conversation.id === id) ?? null : null;
    set({
      activeConversationId: id,
      activeAgentProfileId: selectedConversation?.agent_profile_id ?? get().activeAgentProfileId,
      activeConversationState: null,
    });
    
    if (id) {
      // Fetch timeline when a conversation is selected
      try {
        const [timeline, conversationState] = await Promise.all([
          API.getConversationTimeline(id),
          API.getConversationState(id),
        ]);
        set({ activeTimeline: timeline, activeConversationState: conversationState });
        
        // If the conversation is active (running/starting), start background sync
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

  sendMessage: async (text: string, attachments: Types.AttachmentInput[] = []) => {
    const state = get();
    
    if (!state.activeWorkspace) return;
    if (!state.activeAgentProfileId) {
      console.error("No active agent profile selected");
      return;
    }
    
    let conversationId = state.activeConversationId;
    let pendingConversationId: string | null = null;
    
    // If it's a new chat, create it first
    if (!conversationId) {
      pendingConversationId = `local-conversation-${Date.now()}`;
      const pendingTurnId = `local-turn-${pendingConversationId}`;
      const pendingConversation: Types.Conversation = {
        id: pendingConversationId,
        workspace_id: state.activeWorkspace.id,
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
      set((s) => ({
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
        const newConvState = await API.createConversation({
          workspace_id: state.activeWorkspace.id,
          agent_profile_id: state.activeAgentProfileId,
          title: pendingConversation.title,
        });
        conversationId = newConvState.conversation.id;
        set((s) => ({
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
        }));
      } catch (err: any) {
        console.error('Failed to create conversation', err.code ? err : err);
        set((s) => ({
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
        }));
        throw err;
      }
    }

    // Send the message
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
      
      // Start background sync. We don't overwrite activeTimeline here 
      // because events and polling will handle it more accurately.
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
    if (conversationId.startsWith('local-conversation-')) {
      set((state) => {
        const nextConversations = state.conversations.filter((conversation) => conversation.id !== conversationId);
        const isActive = state.activeConversationId === conversationId;
        return {
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
        const nextConversations = state.conversations.filter((conversation) => conversation.id !== conversationId);
        const isActive = state.activeConversationId === conversationId;
        return {
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

  _setupEventSubscriptions: () => {
    if (get().hasEventSubscriptions) return;
    set({ hasEventSubscriptions: true });

    // Message Appended
    Events.onConversationMessageAppended((payload) => {
      set((state) => {
        if (state.activeConversationId !== payload.conversation_id || !state.activeTimeline) return state;
        
        // Only add if we don't already have it
        const exists = state.activeTimeline.messages.some(m => m.id === payload.message.id);
        if (exists) return state;

        return {
          activeTimeline: {
            ...state.activeTimeline,
            messages: [...state.activeTimeline.messages, payload.message].sort((a, b) => 
              new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
            ),
          }
        };
      });
    });

    // Message Updated (e.g. streaming chunks)
    Events.onConversationMessageUpdated((payload) => {
      set((state) => {
        if (state.activeConversationId !== payload.conversation_id || !state.activeTimeline) return state;
        const exists = state.activeTimeline.messages.some(m => m.id === payload.message.id);
        return {
          activeTimeline: {
            ...state.activeTimeline,
            messages: exists
              ? state.activeTimeline.messages.map(m => 
                  m.id === payload.message.id ? payload.message : m
                )
              : [...state.activeTimeline.messages, payload.message].sort((a, b) =>
                  new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
                ),
          }
        };
      });
    });

    // Terminal Output
    Events.onConversationTerminalOutput((payload) => {
      set((state) => {
        if (state.activeConversationId !== payload.conversation_id || !state.activeTimeline) return state;
        
        // If it's a lifecycle terminal event, update terminals array
        if (payload.terminal) {
          const terminal = payload.terminal;
          const exists = state.activeTimeline.terminals.some(t => t.id === terminal.id);
          
          return {
            activeTimeline: {
              ...state.activeTimeline,
              terminals: exists 
                ? state.activeTimeline.terminals.map(t => t.id === terminal.id ? terminal : t)
                : [...state.activeTimeline.terminals, terminal]
            }
          };
        }
        
        return state;
      });
    });
    
    // Conversation State Changed
    Events.onConversationStateChanged((payload) => {
      set((state) => {
        // Update conversation in the list
        const updatedConversations = state.conversations.map(c => 
          c.id === payload.conversation_id ? { ...c, status: payload.state.conversation.status } : c
        );
        return { 
          conversations: updatedConversations,
          activeConversationState: state.activeConversationId === payload.conversation_id
            ? payload.state
            : state.activeConversationState,
          activeAgentProfileId: state.activeConversationId === payload.conversation_id
            ? payload.state.conversation.agent_profile_id
            : state.activeAgentProfileId,
        };
      });
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
      set((state) => {
        const nextConversations = state.conversations.filter((conversation) => conversation.id !== payload.conversation_id);
        const isActive = state.activeConversationId === payload.conversation_id;
        return {
          conversations: nextConversations,
          activeConversationId: isActive ? null : state.activeConversationId,
          activeConversationState: isActive ? null : state.activeConversationState,
          activeTimeline: isActive ? null : state.activeTimeline,
        };
      });
    });
    
    // Conversation Tool Call Changed
    Events.onConversationToolCallChanged((payload) => {
      set((state) => {
        if (state.activeConversationId !== payload.conversation_id || !state.activeTimeline) return state;
        
        const toolCall = payload.tool_call;
        const exists = state.activeTimeline.tool_calls.some(t => t.id === toolCall.id);
        
        return {
          activeTimeline: {
            ...state.activeTimeline,
            tool_calls: exists
              ? state.activeTimeline.tool_calls.map(t => t.id === toolCall.id ? toolCall : t)
              : [...state.activeTimeline.tool_calls, toolCall]
          }
        };
      });
    });
  }
}));
