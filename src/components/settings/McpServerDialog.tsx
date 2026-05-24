import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { X, AlertCircle } from 'lucide-react';
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
  formError: string | null;
  onSave: () => void;
  onClose: () => void;
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
  formError,
  onSave,
  onClose,
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

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
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
        <div className="px-4 py-4 space-y-3">
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

          {/* Command */}
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

          {/* Args */}
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

          {/* Env */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-silver uppercase tracking-wider">
              {t('mcp.env')}
            </label>
            <textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={t('mcp.envPlaceholder')}
              rows={3}
              className="w-full px-3 py-2 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors font-mono resize-none"
            />
          </div>

          {/* Enabled toggle */}
          <div className="flex items-center justify-between py-1">
            <span className="text-[13px] text-pure-black">{t('mcp.enabled')}</span>
            <button
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
        </div>

        {/* Footer */}
        <div className="flex gap-2 justify-end px-4 py-3 border-t border-light-gray/50 bg-snow">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-interactive text-[13px] font-medium bg-pure-white text-stone hover:bg-light-gray/30 border border-light-gray transition-colors"
          >
            {t('cancel')}
          </button>
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