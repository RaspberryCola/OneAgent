import { useState, useCallback, useRef, useEffect } from 'react';
import { Loader2, FileCode, GitCompareArrows, Eye } from 'lucide-react';
import type * as Types from '../../lib/backend/types';
import type { SelectedFileInfo, ContextMenuState } from '../../hooks/useWorkspaceFileTree';
import type { GitDiffErrorType } from '../../hooks/useGitDiff';
import { WorkspaceFileTree } from './WorkspaceFileTree';
import { DiffPanel } from './DiffPanel';
import { FilePreviewPanel } from './FilePreviewPanel';
import { WorkspaceFileContextMenu } from './WorkspaceFileContextMenu';
import { CustomScrollbar } from '../ui/CustomScrollbar';

const MIN_WIDTH = 200;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 320;

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
  gitDiffData: Types.GitDiffResult | null;
  isGitDiffLoading: boolean;
  gitDiffError: string | null;
  gitDiffErrorType: GitDiffErrorType;
  onRefreshGitDiff: () => void;
  // File preview props
  selectedFile: SelectedFileInfo | null;
  onSelectFile: (filePath: string, fileName: string) => void;
  onClearSelection: () => void;
  // Context menu props
  contextMenuState: ContextMenuState | null;
  onShowContextMenu: (entry: Types.WorkspaceFileEntry, event: React.MouseEvent) => void;
  onHideContextMenu: () => void;
  onNotice: (message: string | null) => void;
}

type SidebarTab = 'files' | 'diff' | 'preview';

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
  gitDiffData,
  isGitDiffLoading,
  gitDiffError,
  gitDiffErrorType,
  onRefreshGitDiff,
  selectedFile,
  onSelectFile,
  onClearSelection,
  contextMenuState,
  onShowContextMenu,
  onHideContextMenu,
  onNotice,
}: WorkspacePanelProps) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('files');
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [isDragging, setIsDragging] = useState(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // Switch to preview tab when file is selected
  useEffect(() => {
    if (selectedFile && !selectedFile.isLoading) {
      setActiveTab('preview');
    }
  }, [selectedFile?.isLoading, selectedFile?.path]);

  useEffect(() => {
    return () => { dragCleanupRef.current?.(); };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);

    const startX = e.clientX;
    const startWidth = width;

    const onMouseMove = (e: MouseEvent) => {
      const delta = startX - e.clientX; // dragging left increases width
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
      setWidth(newWidth);
    };

    const onMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      dragCleanupRef.current = null;
    };

    dragCleanupRef.current = onMouseUp;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [width]);

  return (
    <aside
      className={`bg-snow relative flex-shrink-0 ${
        isDragging ? '' : 'transition-all duration-200'
      } ${isOpen ? '' : 'w-0 overflow-hidden'}`}
      style={isOpen ? { width } : undefined}
    >
      {/* resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-light-gray/60 z-10"
        onMouseDown={handleMouseDown}
      />
      <div className="h-full flex flex-col" style={isOpen ? { width } : undefined}>
        <div className="px-4 py-3 border-b border-light-gray/40 flex items-center justify-between gap-2">
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={() => setActiveTab('files')}
              className={`p-1.5 rounded-interactive transition-colors ${
                activeTab === 'files'
                  ? 'bg-light-gray text-pure-black'
                  : 'text-stone hover:bg-light-gray/40 hover:text-pure-black'
              }`}
              title="Files"
            >
              <FileCode className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setActiveTab('diff')}
              className={`p-1.5 rounded-interactive transition-colors ${
                activeTab === 'diff'
                  ? 'bg-light-gray text-pure-black'
                  : 'text-stone hover:bg-light-gray/40 hover:text-pure-black'
              }`}
              title="Diff"
            >
              <GitCompareArrows className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setActiveTab('preview')}
              className={`p-1.5 rounded-interactive transition-colors ${
                activeTab === 'preview'
                  ? 'bg-light-gray text-pure-black'
                  : 'text-stone hover:bg-light-gray/40 hover:text-pure-black'
              }`}
              title="Preview"
            >
              <Eye className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="text-[11px] text-stone truncate min-w-0 text-right" title={cwd ?? ''}>
            {cwd ?? 'No active workspace'}
          </div>
        </div>

        <CustomScrollbar className="flex-1 p-3">
          {activeTab === 'files' ? (
            isRootLoading ? (
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
                onSelectFile={onSelectFile}
                onContextMenu={onShowContextMenu}
              />
            )
          ) : activeTab === 'diff' ? (
            <DiffPanel
              data={gitDiffData}
              isLoading={isGitDiffLoading}
              error={gitDiffError}
              errorType={gitDiffErrorType}
              onRefresh={onRefreshGitDiff}
            />
          ) : (
            <FilePreviewPanel
              selectedFile={selectedFile}
              onClear={onClearSelection}
            />
          )}
        </CustomScrollbar>
      </div>

      {/* Context menu (rendered outside the panel for proper positioning) */}
      {contextMenuState && cwd && (
        <WorkspaceFileContextMenu
          entry={contextMenuState.entry}
          cwd={cwd}
          position={contextMenuState.position}
          onClose={onHideContextMenu}
          onNotice={onNotice}
        />
      )}
    </aside>
  );
}