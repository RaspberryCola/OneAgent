import { Loader2, FileCode, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import type { SelectedFileInfo } from '../../hooks/useWorkspaceFileTree';
import { getCodeMirrorLanguageExtensions } from '../../lib/utils/codemirrorLanguages';
import { oneAgentLightExtensions } from '../../lib/utils/codemirrorTheme';

interface FilePreviewPanelProps {
  selectedFile: SelectedFileInfo | null;
  onClear: () => void;
}

export function FilePreviewPanel({ selectedFile }: FilePreviewPanelProps) {
  const { t } = useTranslation('workspace');

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
    <div className="h-full overflow-auto min-h-0">
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
    </div>
  );
}
