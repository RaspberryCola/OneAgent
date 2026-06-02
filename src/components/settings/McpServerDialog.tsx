import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { X, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import type * as Types from '../../lib/backend/types';

interface McpServerDialogProps {
  isOpen: boolean;
  mode: 'add' | 'edit';
  workspaceId: string;
  formData: Types.McpServerConfig;
  setFormData: (data: Types.McpServerConfig) => void;
  argsText: string;
  setArgsText: (text: string) => void;
  envText: string;
  setEnvText: (text: string) => void;
  headersText: string;
  setHeadersText: (text: string) => void;
  formError: string | null;
  testResult?: { success: boolean; message: string } | null;
  onSave: () => void;
  onClose: () => void;
  onTest?: () => void;
  isTesting?: boolean;
}

export function McpServerDialog({
  isOpen,
  mode,
  workspaceId,
  formData,
  setFormData,
  argsText,
  setArgsText,
  envText,
  setEnvText,
  headersText,
  setHeadersText,
  formError,
  testResult,
  onSave,
  onClose,
  onTest,
  isTesting,
}: McpServerDialogProps) {
  const { t } = useTranslation('settings');

  // Handle Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isStdio = formData.type === 'stdio';
  const isHttp = formData.type === 'http' || formData.type === 'sse';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      data-settings-child-dialog
      className="fixed inset-0 bg-pure-black/20 z-[110] flex items-center justify-center"
    >
      {/* Backdrop */}
      <div className="absolute inset-0" onClick={onClose} />

      {/* Dialog */}
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="relative z-10 w-full max-w-md bg-pure-white rounded-container border border-light-gray shadow-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-light-gray/50">
          <h2 className="font-display font-medium text-[14px] text-pure-black">
            {mode === 'add' ? t('mcp.add') : t('mcp.edit')}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-interactive text-stone hover:text-pure-black hover:bg-light-gray/30 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form content */}
        <div className="px-4 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
          {/* Name */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-silver uppercase tracking-wider">
              {t('mcp.name')} *
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g. filesystem"
              className="w-full px-3 py-2 border border-light-gray/60 rounded-interactive text-[13px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors"
              autoFocus={mode === 'add'}
            />
          </div>

          {/* Transport Type */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-silver uppercase tracking-wider">
              {t('mcp.transportType')}
            </label>
            <div className="flex gap-2">
              {(['stdio', 'sse', 'http'] as Types.McpTransportType[]).map((tt) => (
                <button
                  key={tt}
                  type="button"
                  onClick={() => setFormData({ ...formData, type: tt })}
                  className={`flex-1 px-3 py-2 rounded-interactive text-[12px] font-medium border transition-colors ${
                    formData.type === tt
                      ? 'bg-pure-black text-pure-white border-pure-black'
                      : 'bg-pure-white text-stone border-light-gray hover:border-pure-black'
                  }`}
                >
                  {t(`mcp.transport${tt.charAt(0).toUpperCase() + tt.slice(1)}`)}
                </button>
              ))}
            </div>
          </div>

          {/* Stdio fields */}
          {isStdio && (
            <>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-silver uppercase tracking-wider">
                  {t('mcp.command')} *
                </label>
                <input
                  type="text"
                  value={formData.command}
                  onChange={(e) => setFormData({ ...formData, command: e.target.value })}
                  placeholder="e.g. npx or uvx"
                  className="w-full px-3 py-2 border border-light-gray/60 rounded-interactive text-[13px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors font-mono"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-silver uppercase tracking-wider">
                  {t('mcp.args')}
                </label>
                <textarea
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder={t('mcp.argsPlaceholder')}
                  rows={2}
                  className="w-full px-3 py-2 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors font-mono resize-none"
                />
              </div>
            </>
          )}

          {/* HTTP/SSE fields */}
          {isHttp && (
            <>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-silver uppercase tracking-wider">
                  {t('mcp.url')} *
                </label>
                <input
                  type="text"
                  value={formData.url}
                  onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                  placeholder={t('mcp.urlPlaceholder')}
                  className="w-full px-3 py-2 border border-light-gray/60 rounded-interactive text-[13px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors font-mono"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-silver uppercase tracking-wider">
                  {t('mcp.headers')}
                </label>
                <textarea
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                  placeholder={t('mcp.headersPlaceholder')}
                  rows={2}
                  className="w-full px-3 py-2 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors font-mono resize-none"
                />
              </div>
            </>
          )}

          {/* Env (for all types) */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-silver uppercase tracking-wider">
              {t('mcp.env')}
            </label>
            <textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={t('mcp.envPlaceholder')}
              rows={2}
              className="w-full px-3 py-2 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors font-mono resize-none"
            />
          </div>

          {/* Enabled toggle */}
          <div className="flex items-center justify-between py-1">
            <span className="text-[13px] text-pure-black">{t('mcp.enabled')}</span>
            <button
              type="button"
              onClick={() => setFormData({ ...formData, enabled: !formData.enabled })}
              className={`relative w-11 h-6 rounded-full transition-colors border ${
                formData.enabled
                  ? 'bg-pure-black border-pure-black'
                  : 'bg-pure-white border-light-gray'
              }`}
            >
              <div
                className={`absolute top-[1px] w-5 h-5 rounded-full transition-transform ${
                  formData.enabled ? 'left-[20px] bg-pure-white' : 'left-[2px] bg-light-gray'
                }`}
              />
            </button>
          </div>

          {/* Error */}
          {formError && (
            <div className="flex gap-2 p-2 rounded-interactive bg-snow border border-light-gray/20">
              <AlertCircle className="w-3.5 h-3.5 text-stone shrink-0" />
              <p className="text-[11px] text-stone">{formError}</p>
            </div>
          )}

          {/* Test result */}
          {testResult && (
            <div className={`flex gap-2 p-2 rounded-interactive border ${
              testResult.success
                ? 'bg-green-50 border-green-200'
                : 'bg-red-50 border-red-200'
            }`}>
              {testResult.success ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />
              ) : (
                <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
              )}
              <p className={`text-[11px] ${testResult.success ? 'text-green-700' : 'text-red-600'}`}>
                {testResult.message}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2 justify-end px-4 py-3 border-t border-light-gray/50 bg-snow">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-interactive text-[13px] font-medium bg-pure-white text-stone hover:bg-light-gray/30 border border-light-gray transition-colors"
          >
            {t('cancel')}
          </button>
          {onTest && (
            <button
              onClick={onTest}
              disabled={isTesting}
              className="px-4 py-2 rounded-interactive text-[13px] font-medium bg-pure-white text-pure-black hover:bg-light-gray/30 border border-light-gray transition-colors disabled:opacity-50"
            >
              {isTesting ? t('mcp.testing') : t('mcp.test')}
            </button>
          )}
          <button
            onClick={onSave}
            className="px-4 py-2 rounded-interactive text-[13px] font-medium bg-pure-black text-pure-white hover:bg-near-black transition-colors"
          >
            {t('save')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
