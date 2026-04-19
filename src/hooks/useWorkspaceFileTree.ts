import { useState, useCallback, useEffect } from 'react';
import * as API from '../lib/backend/commands';
import type * as Types from '../lib/backend/types';

export interface UseWorkspaceFileTreeOptions {
  workspaceId: string | null;
  cwd: string | null;
  enabled?: boolean;
}

export interface UseWorkspaceFileTreeReturn {
  // State
  isPanelOpen: boolean;
  setIsPanelOpen: (open: boolean) => void;
  rootFiles: Types.WorkspaceFileEntry[];
  isRootLoading: boolean;
  rootError: string | null;
  expandedDirs: Set<string>;
  dirChildren: Record<string, Types.WorkspaceFileEntry[]>;
  loadingDirs: Set<string>;
  dirErrors: Record<string, string>;

  // Methods
  toggleDirectory: (dirPath: string) => Promise<void>;
  refreshRoot: () => Promise<void>;
  collapseDirectory: (dirPath: string) => void;
}

/**
 * 自定义 Hook 用于管理工作区文件树的展开/折叠和加载状态
 *
 * 功能：
 * - 管理工作区根文件列表加载
 * - 处理目录展开/折叠状态
 * - 按需加载子目录内容
 * - 错误处理和加载状态管理
 */
export function useWorkspaceFileTree(options: UseWorkspaceFileTreeOptions): UseWorkspaceFileTreeReturn {
  const { workspaceId, cwd, enabled = true } = options;

  // Panel state
  const [isPanelOpen, setIsPanelOpen] = useState(false);

  // Root files state
  const [rootFiles, setRootFiles] = useState<Types.WorkspaceFileEntry[]>([]);
  const [isRootLoading, setIsRootLoading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);

  // Directory state
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirChildren, setDirChildren] = useState<Record<string, Types.WorkspaceFileEntry[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({});

  // Reset all state when panel is closed or workspace changes
  useEffect(() => {
    if (!isPanelOpen || !workspaceId || !cwd) {
      setRootFiles([]);
      setRootError(null);
      setIsRootLoading(false);
      setExpandedDirs(new Set());
      setDirChildren({});
      setLoadingDirs(new Set());
      setDirErrors({});
      return;
    }
  }, [isPanelOpen, workspaceId, cwd]);

  // Load root files when panel is opened or workspace changes
  useEffect(() => {
    if (!isPanelOpen || !cwd) {
      setRootFiles([]);
      setRootError(null);
      setIsRootLoading(false);
      setExpandedDirs(new Set());
      setDirChildren({});
      setLoadingDirs(new Set());
      setDirErrors({});
      return;
    }

    let cancelled = false;
    setIsRootLoading(true);
    setRootError(null);
    setExpandedDirs(new Set());
    setDirChildren({});
    setLoadingDirs(new Set());
    setDirErrors({});

    void API.listWorkspaceFiles(cwd)
      .then((entries) => {
        if (cancelled) return;
        setRootFiles(entries);
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Failed to load workspace files';
        setRootFiles([]);
        setRootError(message);
      })
      .finally(() => {
        if (!cancelled) {
          setIsRootLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, isPanelOpen]);

  const refreshRoot = useCallback(async () => {
    if (!cwd) return;

    let cancelled = false;
    setIsRootLoading(true);
    setRootError(null);

    try {
      const entries = await API.listWorkspaceFiles(cwd);
      if (!cancelled) {
        setRootFiles(entries);
      }
    } catch (error) {
      if (!cancelled) {
        const message = error instanceof Error ? error.message : 'Failed to load workspace files';
        setRootFiles([]);
        setRootError(message);
      }
    } finally {
      if (!cancelled) {
        setIsRootLoading(false);
      }
    }
  }, [cwd]);

  const collapseDirectory = useCallback((dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      next.delete(dirPath);
      return next;
    });
  }, []);

  const toggleDirectory = useCallback(async (dirPath: string) => {
    const alreadyExpanded = expandedDirs.has(dirPath);

    // If already expanded, collapse it
    if (alreadyExpanded) {
      collapseDirectory(dirPath);
      return;
    }

    // Expand the directory
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      next.add(dirPath);
      return next;
    });

    // If children are already loaded or currently loading, do nothing more
    if (dirChildren[dirPath] || loadingDirs.has(dirPath)) {
      return;
    }

    // Load children on demand
    setLoadingDirs((prev) => {
      const next = new Set(prev);
      next.add(dirPath);
      return next;
    });
    setDirErrors((prev) => {
      const next = { ...prev };
      delete next[dirPath];
      return next;
    });

    if (!cwd) return;

    void API.listWorkspaceFiles(cwd, dirPath)
      .then((entries) => {
        setDirChildren((prev) => ({ ...prev, [dirPath]: entries }));
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to load directory';
        setDirErrors((prev) => ({ ...prev, [dirPath]: message }));
      })
      .finally(() => {
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      });
  }, [cwd, dirChildren, expandedDirs, loadingDirs, collapseDirectory]);

  return {
    // State
    isPanelOpen,
    setIsPanelOpen,
    rootFiles,
    isRootLoading,
    rootError,
    expandedDirs,
    dirChildren,
    loadingDirs,
    dirErrors,

    // Methods
    toggleDirectory,
    refreshRoot,
    collapseDirectory,
  };
}
