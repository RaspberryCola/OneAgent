import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { recordAgentUsage, getSortedAgentProfiles } from '../agentUsage';
import { STORAGE_KEYS } from '../../constants';
import type * as Types from '../../backend/types';

describe('agentUsage', () => {
  const mockAgent1: Types.AgentProfile = {
    id: 'agent-1',
    kind: 'acp',
    name: 'Claude Code',
    command: 'claude',
    args: [],
    env: {},
    launch_mode: 'native',
    display_source: 'native',
    capabilities_cache: null,
    enabled: true,
  };

  const mockAgent2: Types.AgentProfile = {
    id: 'agent-2',
    kind: 'acp',
    name: 'Gemini Agent',
    command: 'gemini',
    args: [],
    env: {},
    launch_mode: 'native',
    display_source: 'native',
    capabilities_cache: null,
    enabled: true,
  };

  const mockAgent3: Types.AgentProfile = {
    id: 'agent-3',
    kind: 'acp',
    name: 'Baidu Agent',
    command: 'baidu',
    args: [],
    env: {},
    launch_mode: 'native',
    display_source: 'native',
    capabilities_cache: null,
    enabled: true,
  };

  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('recordAgentUsage', () => {
    it('should save agent usage timestamp in localStorage', () => {
      const now = 1234567890;
      vi.setSystemTime(now);

      recordAgentUsage('agent-1');

      const raw = window.localStorage.getItem(STORAGE_KEYS.AGENT_USAGE);
      expect(raw).toBeDefined();
      const parsed = JSON.parse(raw!);
      expect(parsed['agent-1']).toBe(now);
    });

    it('should append usage timestamps for multiple agents', () => {
      vi.setSystemTime(1000);
      recordAgentUsage('agent-1');

      vi.setSystemTime(2000);
      recordAgentUsage('agent-2');

      const raw = window.localStorage.getItem(STORAGE_KEYS.AGENT_USAGE);
      const parsed = JSON.parse(raw!);
      expect(parsed['agent-1']).toBe(1000);
      expect(parsed['agent-2']).toBe(2000);
    });
  });

  describe('getSortedAgentProfiles', () => {
    it('should sort agents by usage timestamp descending', () => {
      // Record usage: agent-2 at t=1000, agent-1 at t=2000
      vi.setSystemTime(1000);
      recordAgentUsage('agent-2');
      vi.setSystemTime(2000);
      recordAgentUsage('agent-1');

      const sorted = getSortedAgentProfiles([mockAgent2, mockAgent1]);
      // agent-1 should be first because it was used most recently (t=2000 > t=1000)
      expect(sorted[0].id).toBe('agent-1');
      expect(sorted[1].id).toBe('agent-2');
    });

    it('should fallback to alphabetical name sort for unused agents', () => {
      // None have been used
      const sorted = getSortedAgentProfiles([mockAgent1, mockAgent2, mockAgent3]);
      // Baidu Agent (agent-3) -> Claude Code (agent-1) -> Gemini Agent (agent-2)
      expect(sorted[0].id).toBe('agent-3');
      expect(sorted[1].id).toBe('agent-1');
      expect(sorted[2].id).toBe('agent-2');
    });

    it('should put used agents before unused agents', () => {
      // Only Gemini Agent (agent-2) is used
      recordAgentUsage('agent-2');

      const sorted = getSortedAgentProfiles([mockAgent1, mockAgent2, mockAgent3]);
      // Gemini Agent (used) should be first.
      // Unused ones: Baidu Agent (agent-3) then Claude Code (agent-1) sorted alphabetically.
      expect(sorted[0].id).toBe('agent-2');
      expect(sorted[1].id).toBe('agent-3');
      expect(sorted[2].id).toBe('agent-1');
    });
  });
});
