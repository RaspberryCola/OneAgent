import { ChevronDown, ChevronRight, Folder, Loader2 } from 'lucide-react';
import type * as Types from '../../lib/backend/types';
import { getFileIcon } from '../../lib/utils/fileIcons';

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
  selectedFilePath?: string | null;
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
  selectedFilePath,
}: WorkspaceFileTreeNodeProps) {
  const isExpanded = expandedDirs.has(entry.path);
  const isLoadingChildren = loadingDirs.has(entry.path);
  const children = dirChildren[entry.path] ?? [];
  const childError = dirErrors[entry.path];
  const isSelected = !entry.is_dir && entry.path === selectedFilePath;

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
        className={`w-full text-left px-2 py-1 rounded-interactive transition-colors ${
          isSelected ? 'bg-light-gray' : 'hover:bg-light-gray/60'
        }`}
        title={entry.path}
      >
        <div className="flex items-center gap-1.5 min-w-0" style={{ paddingLeft: `${depth * 14}px` }}>
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
          ) : (() => {
            const Icon = getFileIcon(entry.name);
            return <Icon className="w-3.5 h-3.5 text-stone shrink-0" />;
          })()}
          <span className="text-[12px] text-pure-black truncate flex-1 min-w-0">{entry.name}</span>
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
                selectedFilePath={selectedFilePath}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}