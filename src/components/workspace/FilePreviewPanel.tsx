import { Loader2, FileCode, AlertCircle, Code, Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import type { SelectedFileInfo } from '../../hooks/useWorkspaceFileTree';
import { getCodeMirrorLanguageExtensions } from '../../lib/utils/codemirrorLanguages';
import { oneAgentLightExtensions } from '../../lib/utils/codemirrorTheme';

const markdownComponents = {
  p: ({ children }: any) => <p className="mb-1 last:mb-0">{children}</p>,
  inlineCode: ({ children }: any) => (
    <code className="bg-snow border border-light-gray px-1.5 py-0.5 rounded-interactive font-mono text-[0.9em] text-pure-black">
      {children}
    </code>
  ),
  ul: ({ children }: any) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }: any) => <li className="text-[13px] leading-relaxed">{children}</li>,
  h1: ({ children }: any) => <h1 className="text-lg font-display font-medium mb-2 mt-3">{children}</h1>,
  h2: ({ children }: any) => <h2 className="text-[15px] font-display font-medium mb-1.5 mt-3">{children}</h2>,
  h3: ({ children }: any) => <h3 className="text-[14px] font-display font-medium mb-1 mt-2">{children}</h3>,
  a: ({ children, href }: any) => (
    <a href={href} className="underline underline-offset-2 hover:text-stone transition-colors">
      {children}
    </a>
  ),
  table: ({ children }: any) => (
    <div className="w-full overflow-x-auto my-2">
      <table className="w-full border-collapse min-w-0">{children}</table>
    </div>
  ),
  thead: ({ children }: any) => <thead className="bg-snow">{children}</thead>,
  tbody: ({ children }: any) => <tbody>{children}</tbody>,
  tr: ({ children }: any) => <tr className="border-b border-light-gray last:border-b-0">{children}</tr>,
  th: ({ children }: any) => (
    <th className="px-3 py-2 text-left text-[12px] font-medium text-near-black border-b border-light-gray">
      {children}
    </th>
  ),
  td: ({ children }: any) => <td className="px-3 py-2 text-[12px] text-pure-black">{children}</td>,
};

type PreviewMode = 'source' | 'rendered';

interface FilePreviewPanelProps {
  selectedFile: SelectedFileInfo | null;
  onClear: () => void;
}

export function FilePreviewPanel({ selectedFile }: FilePreviewPanelProps) {
  const { t } = useTranslation('workspace');
  const [mdMode, setMdMode] = useState<PreviewMode>('rendered');

  const isMarkdown = selectedFile?.language === 'markdown';

  const languageExtensions = useMemo(() => {
    if (!selectedFile?.language) return [];
    return getCodeMirrorLanguageExtensions(selectedFile.language);
  }, [selectedFile?.language]);

  if (!selectedFile) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-[12px] text-stone">
        <FileCode className="w-8 h-8 text-stone/30" />
        <span>{t('selectFileToPreview')}</span>
      </div>
    );
  }

  if (selectedFile.isLoading) {
    return (
      <div className="h-full flex items-center justify-center gap-2 text-[12px] text-stone">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>{t('loading')}</span>
      </div>
    );
  }

  if (selectedFile.error) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-[12px] text-stone px-3">
        <AlertCircle className="w-8 h-8 text-stone/30" />
        <span className="text-center">{selectedFile.error}</span>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {isMarkdown && (
        <div className="flex items-center justify-end gap-0.5 px-2 py-1.5 border-b border-light-gray/40 shrink-0">
          <button
            onClick={() => setMdMode('source')}
            className={`p-1 rounded-interactive transition-colors ${
              mdMode === 'source'
                ? 'bg-light-gray text-pure-black'
                : 'text-stone hover:bg-light-gray/40 hover:text-pure-black'
            }`}
            title={t('source')}
          >
            <Code className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setMdMode('rendered')}
            className={`p-1 rounded-interactive transition-colors ${
              mdMode === 'rendered'
                ? 'bg-light-gray text-pure-black'
                : 'text-stone hover:bg-light-gray/40 hover:text-pure-black'
            }`}
            title={t('preview')}
          >
            <Eye className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto min-h-0 bg-snow">
        {isMarkdown && mdMode === 'rendered' ? (
          <div className="p-4 bg-snow">
            <Streamdown components={markdownComponents} plugins={{ code }} lineNumbers={false}>
              {selectedFile.content || ''}
            </Streamdown>
          </div>
        ) : (
          <CodeMirror
            value={selectedFile.content || ''}
            extensions={[...oneAgentLightExtensions, ...languageExtensions, EditorView.lineWrapping]}
            readOnly={true}
            editable={false}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
              foldGutter: false,
              searchKeymap: true,
            }}
            height="100%"
          />
        )}
      </div>
    </div>
  );
}
