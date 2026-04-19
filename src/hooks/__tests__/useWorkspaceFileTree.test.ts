import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWorkspaceFileTree } from '../useWorkspaceFileTree';
import * as API from '../../lib/backend/commands';

vi.mock('../../lib/backend/commands', () => ({
  listWorkspaceFiles: vi.fn(),
}));

describe('useWorkspaceFileTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockFileEntry = (name: string, isDir: boolean, path: string, sizeBytes?: number): Types.WorkspaceFileEntry => ({
    name,
    is_dir: isDir,
    path,
    size_bytes: sizeBytes ?? 0,
  });

  describe('initialization', () => {
    it('should initialize with default values', () => {
      const { result } = renderHook(() =>
        useWorkspaceFileTree({ workspaceId: null, cwd: null, enabled: true })
      );

      expect(result.current.isPanelOpen).toBe(false);
      expect(result.current.rootFiles).toEqual([]);
      expect(result.current.isRootLoading).toBe(false);
      expect(result.current.rootError).toBe(null);
      expect(result.current.expandedDirs).toEqual(new Set());
      expect(result.current.dirChildren).toEqual({});
      expect(result.current.loadingDirs).toEqual(new Set());
      expect(result.current.dirErrors).toEqual({});
    });

    it('should accept options', () => {
      const { result } = renderHook(() =>
        useWorkspaceFileTree({ workspaceId: 'ws-1', cwd: '/test', enabled: true })
      );

      expect(result.current).toBeDefined();
    });
  });

  describe('panel state management', () => {
    it('should toggle panel open state', () => {
      const { result } = renderHook(() =>
        useWorkspaceFileTree({ workspaceId: null, cwd: null, enabled: true })
      );

      act(() => {
        result.current.setIsPanelOpen(true);
      });

      expect(result.current.isPanelOpen).toBe(true);

      act(() => {
        result.current.setIsPanelOpen(false);
      });

      expect(result.current.isPanelOpen).toBe(false);
    });
  });

  describe('loading root files', () => {
    it('should load root files when panel is opened', async () => {
      const mockFiles = [
        mockFileEntry('src', true, 'src'),
        mockFileEntry('package.json', false, 'package.json', 1024),
      ];
      vi.mocked(API.listWorkspaceFiles).mockResolvedValue(mockFiles);

      const { result, rerender } = renderHook(
        ({ cwd }) => useWorkspaceFileTree({ workspaceId: 'ws-1', cwd, enabled: true }),
        { initialProps: { cwd: null as string | null } }
      );

      // Open panel
      act(() => {
        result.current.setIsPanelOpen(true);
      });

      // Change cwd to trigger loading
      rerender({ cwd: '/test' });

      await waitFor(() => {
        expect(result.current.isRootLoading).toBe(false);
      });

      expect(API.listWorkspaceFiles).toHaveBeenCalledWith('/test');
      expect(result.current.rootFiles).toEqual(mockFiles);
      expect(result.current.rootError).toBe(null);
    });

    it('should handle error when loading root files fails', async () => {
      vi.mocked(API.listWorkspaceFiles).mockRejectedValue(new Error('Failed to load'));

      const { result, rerender } = renderHook(
        ({ cwd }) => useWorkspaceFileTree({ workspaceId: 'ws-1', cwd, enabled: true }),
        { initialProps: { cwd: null as string | null } }
      );

      act(() => {
        result.current.setIsPanelOpen(true);
      });

      rerender({ cwd: '/test' });

      await waitFor(() => {
        expect(result.current.isRootLoading).toBe(false);
      });

      expect(result.current.rootFiles).toEqual([]);
      expect(result.current.rootError).toBe('Failed to load');
    });

    it('should reset state when panel is closed', () => {
      const { result } = renderHook(() =>
        useWorkspaceFileTree({ workspaceId: 'ws-1', cwd: '/test', enabled: true })
      );

      act(() => {
        result.current.setIsPanelOpen(false);
      });

      expect(result.current.rootFiles).toEqual([]);
      expect(result.current.rootError).toBe(null);
      expect(result.current.isRootLoading).toBe(false);
    });
  });

  describe('toggleDirectory', () => {
    it('should collapse directory if already expanded', async () => {
      const { result } = renderHook(() =>
        useWorkspaceFileTree({ workspaceId: 'ws-1', cwd: '/test', enabled: true })
      );

      // First expand the directory
      await act(async () => {
        await result.current.toggleDirectory('src');
      });

      expect(result.current.expandedDirs.has('src')).toBe(true);

      // Now collapse it
      await act(async () => {
        await result.current.toggleDirectory('src');
      });

      expect(result.current.expandedDirs.has('src')).toBe(false);
    });

    it('should expand directory and load children on demand', async () => {
      const mockChildren = [
        mockFileEntry('index.ts', false, 'src/index.ts', 2048),
        mockFileEntry('utils.ts', false, 'src/utils.ts', 1024),
      ];
      vi.mocked(API.listWorkspaceFiles).mockResolvedValue(mockChildren);

      const { result } = renderHook(() =>
        useWorkspaceFileTree({ workspaceId: 'ws-1', cwd: '/test', enabled: true })
      );

      await act(async () => {
        await result.current.toggleDirectory('src');
      });

      await waitFor(() => {
        expect(result.current.loadingDirs.has('src')).toBe(false);
      });

      expect(result.current.expandedDirs.has('src')).toBe(true);
      expect(result.current.dirChildren['src']).toEqual(mockChildren);
      expect(API.listWorkspaceFiles).toHaveBeenCalledWith('/test', 'src');
    });

    it('should handle error when loading children fails', async () => {
      vi.mocked(API.listWorkspaceFiles).mockRejectedValue(new Error('Failed to load directory'));

      const { result } = renderHook(() =>
        useWorkspaceFileTree({ workspaceId: 'ws-1', cwd: '/test', enabled: true })
      );

      await act(async () => {
        await result.current.toggleDirectory('src');
      });

      await waitFor(() => {
        expect(result.current.loadingDirs.has('src')).toBe(false);
      });

      expect(result.current.expandedDirs.has('src')).toBe(true);
      expect(result.current.dirErrors['src']).toBe('Failed to load directory');
    });

    it('should not reload children if already loaded', async () => {
      const mockChildren = [mockFileEntry('index.ts', false, 'src/index.ts', 2048)];
      vi.mocked(API.listWorkspaceFiles).mockResolvedValue(mockChildren);

      const { result } = renderHook(() =>
        useWorkspaceFileTree({ workspaceId: 'ws-1', cwd: '/test', enabled: true })
      );

      // First expansion
      await act(async () => {
        await result.current.toggleDirectory('src');
      });

      await waitFor(() => {
        expect(result.current.loadingDirs.has('src')).toBe(false);
      });

      // Second expansion (should not trigger another API call)
      await act(async () => {
        await result.current.toggleDirectory('src');
      });

      // Collapse
      expect(result.current.expandedDirs.has('src')).toBe(false);

      // Re-expand
      await act(async () => {
        await result.current.toggleDirectory('src');
      });

      // Should still only be called twice (once for initial expand, once for re-expand after collapse)
      expect(API.listWorkspaceFiles).toHaveBeenCalledTimes(1);
    });

    it('should not do anything if cwd is not available', async () => {
      const { result } = renderHook(() =>
        useWorkspaceFileTree({ workspaceId: 'ws-1', cwd: null, enabled: true })
      );

      await act(async () => {
        await result.current.toggleDirectory('src');
      });

      expect(API.listWorkspaceFiles).not.toHaveBeenCalled();
    });
  });

  describe('collapseDirectory', () => {
    it('should collapse a single directory', async () => {
      const { result } = renderHook(() =>
        useWorkspaceFileTree({ workspaceId: 'ws-1', cwd: '/test', enabled: true })
      );

      // Expand first
      act(() => {
        result.current.setIsPanelOpen(true);
      });

      await act(async () => {
        await result.current.toggleDirectory('src');
      });

      expect(result.current.expandedDirs.has('src')).toBe(true);

      act(() => {
        result.current.collapseDirectory('src');
      });

      expect(result.current.expandedDirs.has('src')).toBe(false);
    });
  });

  describe('refreshRoot', () => {
    it('should refresh root files', async () => {
      const mockFiles1 = [mockFileEntry('file1.txt', false, 'file1.txt', 100)];
      const mockFiles2 = [mockFileEntry('file2.txt', false, 'file2.txt', 200)];

      vi.mocked(API.listWorkspaceFiles)
        .mockResolvedValueOnce(mockFiles1)
        .mockResolvedValueOnce(mockFiles2);

      const { result } = renderHook(() =>
        useWorkspaceFileTree({ workspaceId: 'ws-1', cwd: '/test', enabled: true })
      );

      act(() => {
        result.current.setIsPanelOpen(true);
      });

      await waitFor(() => {
        expect(result.current.isRootLoading).toBe(false);
      });

      expect(result.current.rootFiles).toEqual(mockFiles1);

      // Refresh with new files
      await act(async () => {
        await result.current.refreshRoot();
      });

      await waitFor(() => {
        expect(result.current.isRootLoading).toBe(false);
      });

      expect(result.current.rootFiles).toEqual(mockFiles2);
    });

    it('should handle refresh error', async () => {
      vi.mocked(API.listWorkspaceFiles)
        .mockResolvedValueOnce([mockFileEntry('file.txt', false, 'file.txt', 100)])
        .mockRejectedValueOnce(new Error('Refresh failed'));

      const { result } = renderHook(() =>
        useWorkspaceFileTree({ workspaceId: 'ws-1', cwd: '/test', enabled: true })
      );

      act(() => {
        result.current.setIsPanelOpen(true);
      });

      await waitFor(() => {
        expect(result.current.isRootLoading).toBe(false);
      });

      await act(async () => {
        await result.current.refreshRoot();
      });

      await waitFor(() => {
        expect(result.current.isRootLoading).toBe(false);
      });

      expect(result.current.rootError).toBe('Refresh failed');
    });
  });

  describe('cleanup and reset', () => {
    it('should reset all state when panel is closed', () => {
      const { result } = renderHook(() =>
        useWorkspaceFileTree({ workspaceId: 'ws-1', cwd: '/test', enabled: true })
      );

      act(() => {
        result.current.setIsPanelOpen(true);
      });

      // Simulate some state changes
      act(async () => {
        await result.current.toggleDirectory('src');
      });

      // Close panel
      act(() => {
        result.current.setIsPanelOpen(false);
      });

      expect(result.current.rootFiles).toEqual([]);
      expect(result.current.expandedDirs).toEqual(new Set());
      expect(result.current.dirChildren).toEqual({});
    });
  });
});

// Type import for TypeScript
import type * as Types from '../../lib/backend/types';
