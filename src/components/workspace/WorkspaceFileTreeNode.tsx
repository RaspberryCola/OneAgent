import { ChevronDown, ChevronRight, Code, Folder, Loader2 } from 'lucide-react';
import type * as Types from '../../lib/backend/types';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

interface WorkspaceFileTreeNodeProps {
  entry: Types.WorkspaceFileEntry;
  depth: number;
  expandedDirs: Set<string>;
  loadingDirs: Set<string>;
  dirChildren: Record<string, Types.WorkspaceFileEntry[]>;
  dirErrors: Record<string, string>;
  onToggleDirectory: (path: string) => void;
  onSelectFile?: (filePath: string, fileName: string) => void;
  onContextMenu?: (entry: Types.WorkspaceFileEntry, event: React.MouseEvent) => void;
}

export function WorkspaceFileTreeNode({
  entry,
  depth,
  expandedDirs,
  loadingDirs,
  dirChildren,
  dirErrors,
  onToggleDirectory,
  onSelectFile,
  onContextMenu,
}: WorkspaceFileTreeNodeProps) {
  const isExpanded = expandedDirs.has(entry.path);
  const isLoadingChildren = loadingDirs.has(entry.path);
  const children = dirChildren[entry.path] ?? [];
  const childError = dirErrors[entry.path];

  const handleClick = () => {
    if (entry.is_dir) {
      onToggleDirectory(entry.path);
    } else if (onSelectFile) {
      onSelectFile(entry.path, entry.name);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (onContextMenu) {
      onContextMenu(entry, e);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        className="w-full text-left px-2 py-1.5 rounded-interactive hover:bg-snow/90 transition-colors"
        title={entry.path}
      >
        <div className="flex items-center gap-2 min-w-0" style={{ paddingLeft: `${depth * 14}px` }}>
          {entry.is_dir ? (
            isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-stone shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-stone shrink-0" />
            )
          ) : (
            <span className="w-3.5 h-3.5 shrink-0" />
          )}
          {entry.is_dir ? (
            <Folder className="w-3.5 h-3.5 text-stone shrink-0" />
          ) : (
            <Code className="w-3.5 h-3.5 text-stone shrink-0" />
          )}
          <span className="text-[12px] text-pure-black truncate flex-1 min-w-0">{entry.name}</span>
          {!entry.is_dir && (
            <span className="text-[10px] text-silver shrink-0">{formatBytes(entry.size_bytes ?? 0)}</span>
          )}
        </div>
      </button>

      {entry.is_dir && isExpanded && (
        <div>
          {isLoadingChildren ? (
            <div className="ml-2 py-1.5 text-[11px] text-stone flex items-center gap-1.5" style={{ paddingLeft: `${(depth + 1) * 14}px` }}>
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Loading...</span>
            </div>
          ) : childError ? (
            <div className="ml-2 py-1.5 text-[11px] text-stone truncate" style={{ paddingLeft: `${(depth + 1) * 14}px` }}>
              {childError}
            </div>
          ) : children.length === 0 ? (
            <div className="ml-2 py-1.5 text-[11px] text-silver" style={{ paddingLeft: `${(depth + 1) * 14}px` }}>
              Empty
            </div>
          ) : (
            children.map((child) => (
              <WorkspaceFileTreeNode
                key={child.path}
                entry={child}
                depth={depth + 1}
                expandedDirs={expandedDirs}
                loadingDirs={loadingDirs}
                dirChildren={dirChildren}
                dirErrors={dirErrors}
                onToggleDirectory={onToggleDirectory}
                onSelectFile={onSelectFile}
                onContextMenu={onContextMenu}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}