import { Loader2, X, FileCode, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { SelectedFileInfo } from '../../hooks/useWorkspaceFileTree';
import { getLanguageDisplayName } from '../../lib/utils/languageDetection';
import { formatBytes } from './WorkspaceFileTreeNode';

interface FilePreviewPanelProps {
  selectedFile: SelectedFileInfo | null;
  onClear: () => void;
}

export function FilePreviewPanel({ selectedFile, onClear }: FilePreviewPanelProps) {
  const { t } = useTranslation('workspace');

  // Empty state - no file selected
  if (!selectedFile) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-[12px] text-stone">
        <FileCode className="w-8 h-8 text-stone/30" />
        <span>{t('selectFileToPreview')}</span>
      </div>
    );
  }

  // Loading state
  if (selectedFile.isLoading) {
    return (
      <div className="h-full flex flex-col gap-3">
        <div className="px-3 py-2 border-b border-light-gray/40 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <FileCode className="w-3.5 h-3.5 text-stone shrink-0" />
            <span className="text-[12px] text-pure-black truncate font-mono">{selectedFile.name}</span>
          </div>
          <button
            onClick={onClear}
            className="p-1 text-stone hover:text-pure-black rounded-interactive hover:bg-light-gray/40 transition-colors shrink-0"
            title={t('close')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center gap-2 text-[12px] text-stone">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>{t('loading')}</span>
        </div>
      </div>
    );
  }

  // Error state
  if (selectedFile.error) {
    return (
      <div className="h-full flex flex-col gap-3">
        <div className="px-3 py-2 border-b border-light-gray/40 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <FileCode className="w-3.5 h-3.5 text-stone shrink-0" />
            <span className="text-[12px] text-pure-black truncate font-mono">{selectedFile.name}</span>
          </div>
          <button
            onClick={onClear}
            className="p-1 text-stone hover:text-pure-black rounded-interactive hover:bg-light-gray/40 transition-colors shrink-0"
            title={t('close')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[12px] text-stone px-3">
          <AlertCircle className="w-8 h-8 text-stone/30" />
          <span className="text-center">{selectedFile.error}</span>
          <button
            onClick={onClear}
            className="px-3 py-1.5 text-[11px] text-stone hover:text-pure-black rounded-interactive hover:bg-light-gray/40 transition-colors"
          >
            {t('close')}
          </button>
        </div>
      </div>
    );
  }

  // Success state - show file content
  const language = selectedFile.language || 'plaintext';
  const displayName = getLanguageDisplayName(language);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 border-b border-light-gray/40 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode className="w-3.5 h-3.5 text-stone shrink-0" />
          <span className="text-[12px] text-pure-black truncate font-mono">{selectedFile.name}</span>
          <span className="text-[10px] text-stone shrink-0 px-1.5 py-0.5 rounded-interactive bg-snow border border-light-gray/40">
            {displayName}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-silver">{formatBytes(selectedFile.sizeBytes)}</span>
          <button
            onClick={onClear}
            className="p-1 text-stone hover:text-pure-black rounded-interactive hover:bg-light-gray/40 transition-colors"
            title={t('close')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <SyntaxHighlighter
          language={language}
          style={oneLight}
          showLineNumbers
          lineNumberStyle={{
            minWidth: '3em',
            paddingRight: '1em',
            color: '#a0a0a0',
            fontSize: '11px',
            textAlign: 'right',
            userSelect: 'none',
          }}
          codeTagProps={{
            style: {
              fontSize: '12px',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              lineHeight: '1.6',
            },
          }}
          customStyle={{
            margin: 0,
            padding: '12px',
            background: 'transparent',
            overflow: 'auto',
          }}
        >
          {selectedFile.content || ''}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}