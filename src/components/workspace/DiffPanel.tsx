import { useState, useMemo, useRef, useEffect } from 'react';
import {
  Loader2,
  RefreshCw,
  FileCode,
  ChevronRight,
  GitBranch,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { unifiedMergeView } from '@codemirror/merge';
import { defaultKeymap } from '@codemirror/commands';
import type * as Types from '../../lib/backend/types';
import type { GitDiffErrorType } from '../../hooks/useGitDiff';
import { detectLanguage } from '../../lib/utils/languageDetection';
import { getCodeMirrorLanguageExtensions } from '../../lib/utils/codemirrorLanguages';
import { oneAgentDiffExtensions } from '../../lib/utils/codemirrorTheme';

// --- Types ---

type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';

interface DiffHunkLine {
  type: 'context' | 'add' | 'remove';
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffHunkLine[];
}

interface DiffFile {
  oldPath: string;
  newPath: string;
  status: FileStatus;
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

// --- Parsing ---

function parseFileStatus(fileDiff: string): FileStatus {
  if (/^new file mode/m.test(fileDiff)) return 'added';
  if (/^deleted file mode/m.test(fileDiff)) return 'deleted';
  if (/^rename from/m.test(fileDiff)) return 'renamed';
  if (/^copy from/m.test(fileDiff)) return 'copied';
  return 'modified';
}

function parseDiffFile(fileDiff: string): DiffFile {
  const headerMatch = fileDiff.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?\s*$/m);
  const rawOld = headerMatch ? headerMatch[1] : 'unknown';
  const rawNew = headerMatch ? headerMatch[2] : 'unknown';
  const oldPath = rawOld.replace(/^"|"$/g, '');
  const newPath = rawNew.replace(/^"|"$/g, '');
  const status = parseFileStatus(fileDiff);

  const hunks: DiffHunk[] = [];
  let added = 0;
  let removed = 0;

  const hunkHeaderRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/gm;
  const hunkMatches = [...fileDiff.matchAll(hunkHeaderRegex)];

  for (let hi = 0; hi < hunkMatches.length; hi++) {
    const match = hunkMatches[hi];
    const oldStart = parseInt(match[1], 10);
    const newStart = parseInt(match[3], 10);
    const header = match[5]?.trim() ?? '';

    const lineStart = match.index! + match[0].length;
    const lineEnd =
      hi + 1 < hunkMatches.length ? hunkMatches[hi + 1].index! : fileDiff.length;
    const hunkBody = fileDiff.slice(lineStart, lineEnd);

    const lines: DiffHunkLine[] = [];
    let oldLine = oldStart;
    let newLine = newStart;

    const rawLines = hunkBody.split('\n');
    // Remove trailing empty string produced by split on final newline
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
      rawLines.pop();
    }

    for (const rawLine of rawLines) {
      if (rawLine === '' && lines.length === 0) continue; // skip leading empty
      if (rawLine.startsWith('\\')) continue; // "\ No newline at end of file"

      if (rawLine.startsWith('+') && !/^\+\+\+ /.test(rawLine)) {
        lines.push({ type: 'add', content: rawLine.slice(1), oldLine: null, newLine });
        newLine++;
        added++;
      } else if (rawLine.startsWith('-') && !/^--- /.test(rawLine)) {
        lines.push({ type: 'remove', content: rawLine.slice(1), oldLine, newLine: null });
        oldLine++;
        removed++;
      } else if (rawLine.startsWith(' ')) {
        lines.push({ type: 'context', content: rawLine.slice(1), oldLine, newLine });
        oldLine++;
        newLine++;
      }
    }

    hunks.push({ header, oldStart, newStart, lines });
  }

  return { oldPath, newPath, status, hunks, added, removed };
}

// --- Extract diff content for MergeView ---

function extractDiffContent(file: DiffFile): { a: string; b: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'context') {
        oldLines.push(line.content);
        newLines.push(line.content);
      } else if (line.type === 'remove') {
        oldLines.push(line.content);
      } else if (line.type === 'add') {
        newLines.push(line.content);
      }
    }
  }

  return {
    a: oldLines.join('\n'),
    b: newLines.join('\n'),
  };
}

// --- Diff line gutter ---

function LineNum({ n }: { n: number | null }) {
  return (
    <span className="inline-block w-10 text-right pr-2 text-stone/50 select-none text-[11px] shrink-0">
      {n != null ? n : ''}
    </span>
  );
}

// --- Diff MergeView wrapper ---

function DiffMergeView({ oldContent, newContent, filePath }: { oldContent: string; newContent: string; filePath: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const language = detectLanguage(filePath);
    const extensions = getCodeMirrorLanguageExtensions(language);

    const state = EditorState.create({
      doc: newContent,
      extensions: [
        ...oneAgentDiffExtensions,
        ...extensions,
        unifiedMergeView({
          original: oldContent,
          highlightChanges: true,
          gutter: true,
          collapseUnchanged: { margin: 3, minSize: 50 },
        }),
        keymap.of(defaultKeymap),
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [oldContent, newContent, filePath]);

  return <div ref={containerRef} className="min-h-[100px]" />;
}

// --- File viewer ---

function DiffFileViewer({ file }: { file: DiffFile }) {
  const [expanded, setExpanded] = useState(false);

  // Extract diff content for MergeView
  const { a: oldContent, b: newContent } = useMemo(
    () => extractDiffContent(file),
    [file]
  );

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-light-gray/30 transition-colors"
        title={file.status === 'renamed' ? `${file.oldPath} → ${file.newPath}` : file.newPath}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[12px] text-pure-black truncate flex-1 min-w-0 font-mono">
            {file.status === 'renamed' ? `${file.oldPath} → ${file.newPath}` : file.newPath}
          </span>
          <span className="text-[10px] font-mono shrink-0 space-x-1">
            {file.added > 0 && (
              <span className="text-emerald-600">+{file.added}</span>
            )}
            {file.removed > 0 && (
              <span className="text-rose-500">-{file.removed}</span>
            )}
          </span>
          <ChevronRight
            className={`w-3.5 h-3.5 text-stone shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </div>
      </button>

      {expanded && (
        <div className="ml-2 mt-0.5 mb-1 border border-light-gray/60 rounded overflow-hidden">
          <DiffMergeView
            oldContent={oldContent}
            newContent={newContent}
            filePath={file.newPath || file.oldPath}
          />
        </div>
      )}
    </div>
  );
}

// --- Section ---

interface DiffSectionProps {
  title: string;
  diff: string;
  actions?: React.ReactNode;
}

function DiffSection({ title, diff, actions }: DiffSectionProps) {
  if (!diff.trim()) return null;

  const files = useMemo(
    () =>
      diff
        .split(/(?=^diff --git )/m)
        .filter(Boolean)
        .map(parseDiffFile),
    [diff],
  );

  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0);

  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between px-1 pb-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-stone uppercase tracking-wide">
            {title}
          </span>
          <span className="text-[10px] font-mono">
            {totalAdded > 0 && <span className="text-emerald-600">+{totalAdded}</span>}
            {totalAdded > 0 && totalRemoved > 0 && <span className="text-stone/40"> </span>}
            {totalRemoved > 0 && <span className="text-rose-500">-{totalRemoved}</span>}
          </span>
        </div>
        {actions}
      </div>
      {files.map((file) => (
        <DiffFileViewer key={`${file.oldPath}\0${file.newPath}`} file={file} />
      ))}
    </div>
  );
}

// --- Not Git Repository state ---

function NotGitRepositoryState({ onRefresh }: { onRefresh: () => void }) {
  const { t } = useTranslation('workspace');
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-[12px] text-stone">
      <GitBranch className="w-8 h-8 text-stone/30" />
      <span>{t('diff.not_a_git_repository')}</span>
      <span className="text-[11px] text-center">{t('diff.not_a_git_repository_hint')}</span>
      <button
        onClick={onRefresh}
        className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-stone hover:text-pure-black rounded-interactive hover:bg-light-gray/40 transition-colors"
      >
        <RefreshCw className="w-3 h-3" />
        {t('refresh')}
      </button>
    </div>
  );
}

// --- Empty state ---

function EmptyState({ onRefresh }: { onRefresh: () => void }) {
  const { t } = useTranslation('workspace');
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-[12px] text-stone">
      <FileCode className="w-8 h-8 text-stone/30" />
      <span>{t('diff.no_changes')}</span>
      <button
        onClick={onRefresh}
        className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-stone hover:text-pure-black rounded-interactive hover:bg-light-gray/40 transition-colors"
      >
        <RefreshCw className="w-3 h-3" />
        {t('refresh')}
      </button>
    </div>
  );
}

// --- Main ---

interface DiffPanelProps {
  data: Types.GitDiffResult | null;
  isLoading: boolean;
  error: string | null;
  errorType: GitDiffErrorType;
  onRefresh: () => void;
}

export function DiffPanel({ data, isLoading, error, errorType, onRefresh }: DiffPanelProps) {
  const { t } = useTranslation('workspace');
  
  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center gap-2 text-[12px] text-stone">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>{t('diff.loading')}</span>
      </div>
    );
  }

  if (errorType === 'not_a_git_repository') {
    return <NotGitRepositoryState onRefresh={onRefresh} />;
  }

  if (error) {
    return (
      <div className="p-3 rounded-container border border-light-gray/60 bg-snow text-[12px] text-stone">
        {error}
      </div>
    );
  }

  if (!data || (!data.unstaged.trim() && !data.staged.trim())) {
    return <EmptyState onRefresh={onRefresh} />;
  }

  return (
    <div className="space-y-4">
      <DiffSection
        title={t('diff.staged_changes')}
        diff={data.staged}
        actions={
          <button
            onClick={onRefresh}
            className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-stone hover:text-pure-black rounded-interactive hover:bg-light-gray/40 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            {t('refresh')}
          </button>
        }
      />
      <DiffSection title={t('diff.unstaged_changes')} diff={data.unstaged} />
    </div>
  );
}
