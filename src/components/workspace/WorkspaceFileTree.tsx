import type * as Types from '../../lib/backend/types';
import { WorkspaceFileTreeNode } from './WorkspaceFileTreeNode';

interface WorkspaceFileTreeProps {
  entries: Types.WorkspaceFileEntry[];
  expandedDirs: Set<string>;
  loadingDirs: Set<string>;
  dirChildren: Record<string, Types.WorkspaceFileEntry[]>;
  dirErrors: Record<string, string>;
  onToggleDirectory: (path: string) => void;
  onSelectFile?: (filePath: string, fileName: string) => void;
  onContextMenu?: (entry: Types.WorkspaceFileEntry, event: React.MouseEvent) => void;
}

export function WorkspaceFileTree({
  entries,
  expandedDirs,
  loadingDirs,
  dirChildren,
  dirErrors,
  onToggleDirectory,
  onSelectFile,
  onContextMenu,
}: WorkspaceFileTreeProps) {
  return (
    <div className="space-y-0.5">
      {entries.map((entry) => (
        <WorkspaceFileTreeNode
          key={entry.path}
          entry={entry}
          depth={0}
          expandedDirs={expandedDirs}
          loadingDirs={loadingDirs}
          dirChildren={dirChildren}
          dirErrors={dirErrors}
          onToggleDirectory={onToggleDirectory}
          onSelectFile={onSelectFile}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  );
}