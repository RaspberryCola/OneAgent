import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSearch } from '../useSearch';
import * as API from '../../lib/backend/commands';

vi.mock('../../lib/backend/commands', () => ({
  searchConversations: vi.fn(),
}));

describe('useSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const mockConversation = (id: string, title: string): Types.Conversation => ({
    id,
    title,
    workspace_id: 'ws-1',
    agent_profile_id: 'agent-1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_event_seq: 0,
    status: 'ready' as Types.Conversation['status'],
    origin: 'agent_discovered' as Types.Conversation['origin'],
  });

  describe('initialization', () => {
    it('should initialize with default values', () => {
      const { result } = renderHook(() =>
        useSearch({ workspaceId: null, enabled: true })
      );

      expect(result.current.isOpen).toBe(false);
      expect(result.current.query).toBe('');
      expect(result.current.results).toEqual([]);
      expect(result.current.isSearching).toBe(false);
    });

    it('should accept custom debounceMs', () => {
      const { result } = renderHook(() =>
        useSearch({ workspaceId: 'ws-1', enabled: true, debounceMs: 500 })
      );

      expect(result.current).toBeDefined();
    });
  });

  describe('open/close search', () => {
    it('should open search panel', () => {
      const { result } = renderHook(() =>
        useSearch({ workspaceId: null, enabled: true })
      );

      act(() => {
        result.current.openSearch();
      });

      expect(result.current.isOpen).toBe(true);
      expect(result.current.query).toBe('');
      expect(result.current.results).toEqual([]);
    });

    it('should close search panel and clear state', () => {
      const { result } = renderHook(() =>
        useSearch({ workspaceId: 'ws-1', enabled: true })
      );

      act(() => {
        result.current.openSearch();
      });

      act(() => {
        result.current.setQuery('test query');
      });

      act(() => {
        result.current.closeSearch();
      });

      expect(result.current.isOpen).toBe(false);
      expect(result.current.query).toBe('');
      expect(result.current.results).toEqual([]);
      expect(result.current.isSearching).toBe(false);
    });

    it('should clear results without closing', () => {
      const { result } = renderHook(() =>
        useSearch({ workspaceId: 'ws-1', enabled: true })
      );

      act(() => {
        result.current.openSearch();
        result.current.setQuery('test');
      });

      act(() => {
        result.current.clearResults();
      });

      expect(result.current.isOpen).toBe(true);
      expect(result.current.query).toBe('');
      expect(result.current.results).toEqual([]);
    });
  });

  describe('search execution', () => {
    it('should execute search with debounce', async () => {
      const mockResults = [
        mockConversation('1', 'Test Chat 1'),
        mockConversation('2', 'Test Chat 2'),
      ];
      vi.mocked(API.searchConversations).mockResolvedValue(mockResults);

      const { result } = renderHook(() =>
        useSearch({ workspaceId: 'ws-1', enabled: true, debounceMs: 300 })
      );

      act(() => {
        result.current.openSearch();
      });

      act(() => {
        result.current.setQuery('test query');
      });

      // Advance time to trigger debounced search
      await act(async () => {
        vi.advanceTimersByTime(300);
        // Wait for the promise to resolve
        await Promise.resolve();
      });

      expect(API.searchConversations).toHaveBeenCalledWith({
        workspace_id: 'ws-1',
        query: 'test query',
      });
      expect(result.current.results).toEqual(mockResults);
      expect(result.current.isSearching).toBe(false);
    });

    it('should cancel previous search when query changes', async () => {
      const mockResults = [mockConversation('1', 'Result')];
      vi.mocked(API.searchConversations).mockResolvedValue(mockResults);

      const { result } = renderHook(() =>
        useSearch({ workspaceId: 'ws-1', enabled: true, debounceMs: 300 })
      );

      act(() => {
        result.current.openSearch();
      });

      // First query
      act(() => {
        result.current.setQuery('first');
      });

      // Change query before debounce completes
      act(() => {
        vi.advanceTimersByTime(100);
        result.current.setQuery('second');
      });

      // Only the second query should execute
      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      expect(API.searchConversations).toHaveBeenCalledTimes(1);
      expect(API.searchConversations).toHaveBeenCalledWith({
        workspace_id: 'ws-1',
        query: 'second',
      });
      expect(result.current.results).toEqual(mockResults);
    });

    it('should handle search error', async () => {
      vi.mocked(API.searchConversations).mockRejectedValue(new Error('Search failed'));

      const { result } = renderHook(() =>
        useSearch({ workspaceId: 'ws-1', enabled: true })
      );

      act(() => {
        result.current.openSearch();
        result.current.setQuery('test');
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      expect(result.current.results).toEqual([]);
      expect(result.current.isSearching).toBe(false);
    });

    it('should not search when query is empty', async () => {
      const { result } = renderHook(() =>
        useSearch({ workspaceId: 'ws-1', enabled: true })
      );

      act(() => {
        result.current.openSearch();
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(API.searchConversations).not.toHaveBeenCalled();
      expect(result.current.results).toEqual([]);
    });

    it('should not search when workspaceId is null', async () => {
      const { result } = renderHook(() =>
        useSearch({ workspaceId: null, enabled: true })
      );

      act(() => {
        result.current.openSearch();
        result.current.setQuery('test');
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(API.searchConversations).not.toHaveBeenCalled();
      expect(result.current.results).toEqual([]);
    });

    it('should execute immediate search without debounce', async () => {
      const mockResults = [mockConversation('1', 'Result')];
      vi.mocked(API.searchConversations).mockResolvedValue(mockResults);

      const { result } = renderHook(() =>
        useSearch({ workspaceId: 'ws-1', enabled: true })
      );

      act(() => {
        result.current.openSearch();
        result.current.setQuery('test');
      });

      // Execute immediate search (bypass debounce)
      await act(async () => {
        result.current.executeSearch();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(API.searchConversations).toHaveBeenCalledTimes(1);
      expect(result.current.results).toEqual(mockResults);
      expect(result.current.isSearching).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should clear timeout on unmount', () => {
      const { result, unmount } = renderHook(() =>
        useSearch({ workspaceId: 'ws-1', enabled: true })
      );

      act(() => {
        result.current.openSearch();
        result.current.setQuery('test');
      });

      // Unmount before debounce completes
      unmount();

      // Should not throw or cause issues
      act(() => {
        vi.advanceTimersByTime(300);
      });
    });

    it('should clear results when closing while searching', async () => {
      // Mock a slow search
      vi.mocked(API.searchConversations).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 500))
      );

      const { result } = renderHook(() =>
        useSearch({ workspaceId: 'ws-1', enabled: true })
      );

      act(() => {
        result.current.openSearch();
        result.current.setQuery('test');
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // Close while searching
      act(() => {
        result.current.closeSearch();
      });

      expect(result.current.isOpen).toBe(false);
      expect(result.current.results).toEqual([]);
    });
  });
});

// Type import for TypeScript
import type * as Types from '../../lib/backend/types';
