import { useState, useCallback, useEffect, useRef } from 'react';
import * as API from '../lib/backend/commands';
import type * as Types from '../lib/backend/types';

export interface UseSearchOptions {
  workspaceId: string | null;
  enabled?: boolean;
  debounceMs?: number; // 防抖延迟，默认 300ms
}

export interface UseSearchReturn {
  // State
  isOpen: boolean;
  query: string;
  results: Types.Conversation[];
  isSearching: boolean;

  // Methods
  openSearch: () => void;
  closeSearch: () => void;
  setQuery: (query: string) => void;
  clearResults: () => void;
  executeSearch: () => void;
}

/**
 * 自定义 Hook 用于管理全局搜索功能
 *
 * 功能：
 * - 控制搜索面板的打开/关闭
 * - 管理搜索查询和结果
 * - 防抖搜索 API 调用
 * - 键盘快捷键处理（ESC 关闭）
 */
export function useSearch(options: UseSearchOptions): UseSearchReturn {
  const { workspaceId, enabled = true, debounceMs = 300 } = options;

  // State
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Types.Conversation[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Refs
  const searchTimeoutRef = useRef<number | null>(null);

  // Clear search timeout on unmount
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current !== null) {
        window.clearTimeout(searchTimeoutRef.current);
      }
    };
  }, []);

  // Execute search when query changes (with debounce)
  useEffect(() => {
    if (!isOpen || !workspaceId || !query.trim()) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    // Clear existing timeout
    if (searchTimeoutRef.current !== null) {
      window.clearTimeout(searchTimeoutRef.current);
    }

    // Schedule new search with debounce
    searchTimeoutRef.current = window.setTimeout(async () => {
      try {
        setIsSearching(true);
        const data = await API.searchConversations({
          workspace_id: workspaceId,
          query: query,
        });
        setResults(data);
      } catch (error) {
        console.error('Search failed:', error);
        setResults([]);
      } finally {
        setIsSearching(false);
      }
      searchTimeoutRef.current = null;
    }, debounceMs);

    // Cleanup function to cancel pending search
    return () => {
      if (searchTimeoutRef.current !== null) {
        window.clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [isOpen, workspaceId, query, debounceMs]);

  const openSearch = useCallback(() => {
    setIsOpen(true);
    setQuery('');
    setResults([]);
  }, []);

  const closeSearch = useCallback(() => {
    setIsOpen(false);
    setQuery('');
    setResults([]);
    setIsSearching(false);
    if (searchTimeoutRef.current !== null) {
      window.clearTimeout(searchTimeoutRef.current);
    }
  }, []);

  const clearResults = useCallback(() => {
    setResults([]);
    setQuery('');
    setIsSearching(false);
    if (searchTimeoutRef.current !== null) {
      window.clearTimeout(searchTimeoutRef.current);
    }
  }, []);

  const executeSearch = useCallback(() => {
    // Force immediate search without debounce
    if (!workspaceId || !query.trim()) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    if (searchTimeoutRef.current !== null) {
      window.clearTimeout(searchTimeoutRef.current);
    }

    void (async () => {
      try {
        setIsSearching(true);
        const data = await API.searchConversations({
          workspace_id: workspaceId,
          query: query,
        });
        setResults(data);
      } catch (error) {
        console.error('Search failed:', error);
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    })();
  }, [workspaceId, query]);

  return {
    // State
    isOpen,
    query,
    results,
    isSearching,

    // Methods
    openSearch,
    closeSearch,
    setQuery,
    clearResults,
    executeSearch,
  };
}
