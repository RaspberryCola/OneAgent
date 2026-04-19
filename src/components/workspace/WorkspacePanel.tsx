import { Loader2 } from 'lucide-react';
import type * as Types from '../../lib/backend/types';
import { WorkspaceFileTree } from './WorkspaceFileTree';

interface WorkspacePanelProps {
  isOpen: boolean;
  cwd?: string | null;
  isRootLoading: boolean;
  rootError: string | null;
  rootFiles: Types.WorkspaceFileEntry[];
  expandedDirs: Set<string>;
  dirChildren: Record<string, Types.WorkspaceFileEntry[]>;
  loadingDirs: Set<string>;
  dirErrors: Record<string, string>;
  onToggleDirectory: (path: string) => void;
}

export function WorkspacePanel({
  isOpen,
  cwd,
  isRootLoading,
  rootError,
  rootFiles,
  expandedDirs,
  dirChildren,
  loadingDirs,
  dirErrors,
  onToggleDirectory,
}: WorkspacePanelProps) {
  return (
    <aside
      className={`bg-pure-white transition-all duration-200 ${
        isOpen ? 'w-[320px]' : 'w-0 overflow-hidden'
      }`}
    >
      <div className="w-[320px] h-full flex flex-col">
        <div className="px-4 py-3 border-b border-light-gray/40">
          <div className="text-[11px] text-stone truncate" title={cwd ?? ''}>
            {cwd ?? 'No active workspace'}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {isRootLoading ? (
            <div className="h-full flex items-center justify-center gap-2 text-[12px] text-stone">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Loading files...</span>
            </div>
          ) : rootError ? (
            <div className="p-3 rounded-container border border-light-gray/60 bg-snow text-[12px] text-stone">
              {rootError}
            </div>
          ) : rootFiles.length === 0 ? (
            <div className="p-3 rounded-container border border-light-gray/60 bg-snow text-[12px] text-stone">
              No files found in this workspace root.
            </div>
          ) : (
            <WorkspaceFileTree
              entries={rootFiles}
              expandedDirs={expandedDirs}
              loadingDirs={loadingDirs}
              dirChildren={dirChildren}
              dirErrors={dirErrors}
              onToggleDirectory={onToggleDirectory}
            />
          )}
        </div>
      </div>
    </aside>
  );
}
