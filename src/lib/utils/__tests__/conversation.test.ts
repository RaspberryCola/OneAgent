import { describe, it, expect } from 'vitest';
import { buildConversationTitle, isConversationActive, findConversationAcrossWorkspaces } from '../conversation';
import type { ConversationState, Conversation } from '../../backend/types';

describe('conversation utilities', () => {
  describe('buildConversationTitle', () => {
    it('should return "Untitled Chat" for empty string', () => {
      expect(buildConversationTitle('')).toBe('Untitled Chat');
    });

    it('should return "Untitled Chat" for whitespace-only string', () => {
      expect(buildConversationTitle('   ')).toBe('Untitled Chat');
      expect(buildConversationTitle('\t\n')).toBe('Untitled Chat');
    });

    it('should normalize multiple spaces to single space', () => {
      expect(buildConversationTitle('hello   world')).toBe('hello world');
    });

    it('should trim leading and trailing whitespace', () => {
      expect(buildConversationTitle('  hello world  ')).toBe('hello world');
    });

    it('should return title as-is if 60 characters or less', () => {
      const shortTitle = 'Hello World';
      expect(buildConversationTitle(shortTitle)).toBe(shortTitle);
    });

    it('should truncate titles longer than 60 characters', () => {
      const longTitle = 'a'.repeat(70);
      const result = buildConversationTitle(longTitle);
      expect(result.length).toBe(63); // 60 + 3 for "..."
      expect(result).toMatch(/^a+\.\.\.$/);
    });

    it('should handle null/undefined gracefully', () => {
      // @ts-expect-error - testing invalid input
      expect(() => buildConversationTitle(null)).toThrow();
      // @ts-expect-error - testing invalid input
      expect(() => buildConversationTitle(undefined)).toThrow();
    });
  });

  describe('isConversationActive', () => {
    const createMockState = (
      sessionPhase: 'cold' | 'loading' | 'hot',
      turnPhase: 'idle' | 'running' | 'cancelling' | 'failed'
    ): ConversationState => ({
      conversation: {
        id: 'test',
        workspace_id: 'test',
        agent_profile_id: 'test',
        origin: 'oneagent_managed',
        status: 'running',
        title: 'Test',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_event_seq: 0,
      },
      runtime: {
        connection_phase: 'ready',
        session_phase: sessionPhase,
        turn_phase: turnPhase,
        last_transition_at: new Date().toISOString(),
      },
      config_options: [],
      pending_permissions: [],
    });

    it('should return false for null state', () => {
      expect(isConversationActive(null)).toBe(false);
    });

    it('should return true when session_phase is loading', () => {
      const state = createMockState('loading', 'idle');
      expect(isConversationActive(state)).toBe(true);
    });

    it('should return true when turn_phase is running', () => {
      const state = createMockState('hot', 'running');
      expect(isConversationActive(state)).toBe(true);
    });

    it('should return true when turn_phase is cancelling', () => {
      const state = createMockState('hot', 'cancelling');
      expect(isConversationActive(state)).toBe(true);
    });

    it('should return true when turn_phase is failed', () => {
      const state = createMockState('hot', 'failed');
      expect(isConversationActive(state)).toBe(true);
    });

    it('should return false when session is hot and turn is idle', () => {
      const state = createMockState('hot', 'idle');
      expect(isConversationActive(state)).toBe(false);
    });

    it('should return false when session is cold and turn is idle', () => {
      const state = createMockState('cold', 'idle');
      expect(isConversationActive(state)).toBe(false);
    });
  });

  describe('findConversationAcrossWorkspaces', () => {
    const createMockConversation = (id: string, workspaceId: string): Conversation => ({
      id,
      workspace_id: workspaceId,
      agent_profile_id: 'test-agent',
      origin: 'oneagent_managed',
      status: 'idle',
      title: `Conversation ${id}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_event_seq: 0,
    });

    it('should return null for empty map', () => {
      const emptyMap = new Map<string, Conversation[]>();
      expect(findConversationAcrossWorkspaces(emptyMap, 'test-id')).toBe(null);
    });

    it('should return null when conversation not found', () => {
      const map = new Map<string, Conversation[]>();
      map.set('ws1', [createMockConversation('conv1', 'ws1')]);
      expect(findConversationAcrossWorkspaces(map, 'nonexistent')).toBe(null);
    });

    it('should find conversation in first workspace', () => {
      const map = new Map<string, Conversation[]>();
      const conv = createMockConversation('conv1', 'ws1');
      map.set('ws1', [conv]);

      const result = findConversationAcrossWorkspaces(map, 'conv1');
      expect(result).toEqual({ workspaceId: 'ws1', conversation: conv });
    });

    it('should find conversation in second workspace', () => {
      const map = new Map<string, Conversation[]>();
      const conv = createMockConversation('conv2', 'ws2');
      map.set('ws1', [createMockConversation('conv1', 'ws1')]);
      map.set('ws2', [conv]);

      const result = findConversationAcrossWorkspaces(map, 'conv2');
      expect(result).toEqual({ workspaceId: 'ws2', conversation: conv });
    });

    it('should handle multiple conversations per workspace', () => {
      const map = new Map<string, Conversation[]>();
      const convs = [
        createMockConversation('conv1', 'ws1'),
        createMockConversation('conv2', 'ws1'),
        createMockConversation('conv3', 'ws1'),
      ];
      map.set('ws1', convs);

      const result = findConversationAcrossWorkspaces(map, 'conv2');
      expect(result).toEqual({ workspaceId: 'ws1', conversation: convs[1] });
    });
  });
});
