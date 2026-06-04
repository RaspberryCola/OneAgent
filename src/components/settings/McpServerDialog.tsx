import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { X, AlertCircle, CheckCircle2, XCircle, Terminal, Globe, Plug } from 'lucide-react';
import type * as Types from '../../lib/backend/types';

const TRANSPORT_OPTIONS: { key: Types.McpTransportType; icon: typeof Terminal; labelKey: string }[] = [
  { key: 'stdio', icon: Terminal, labelKey: 'mcp.transportStdio' },
  { key: 'sse', icon: Globe, labelKey: 'mcp.transportSse' },
  { key: 'http', icon: Globe, labelKey: 'mcp.transportHttp' },
  { key: 'acp', icon: Plug, labelKey: 'mcp.transportAcp' },
];

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

  const [argsValid, setArgsValid] = useState(true);
  const [envValid, setEnvValid] = useState(true);
  const [headersValid, setHeadersValid] = useState(true);

  const validateJson = useCallback((text: string, setter: (valid: boolean) => void) => {
    try {
      if (text.trim()) JSON.parse(text);
      setter(true);
    } catch { setter(false); }
  }, []);

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
  const isAcp = formData.type === 'acp';

  const FieldLabel = ({ children, required }: { children: React.ReactNode; required?: boolean }) => (
    <label className="text-[10px] text-silver uppercase tracking-wider flex items-center gap-1">
      {children}
      {required && <span className="text-rose-500">*</span>}
    </label>
  );

  const fieldCls = "w-full px-3 py-2 border border-light-gray/60 rounded-interactive text-[13px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors";
  const monoFieldCls = `${fieldCls} font-mono text-[12px]`;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      data-settings-child-dialog
      className="fixed inset-0 bg-pure-black/20 z-[110] flex items-center justify-center"
    >
      <div className="absolute inset-0" onClick={onClose} />
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
          <button onClick={onClose} className="p-1 rounded-interactive text-stone hover:text-pure-black hover:bg-light-gray/30 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <div className="px-4 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
          {/* Name */}
          <div className="flex flex-col gap-1">
            <FieldLabel required>{t('mcp.name')}</FieldLabel>
            <input type="text" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="e.g. filesystem" className={fieldCls} autoFocus={mode === 'add'} />
          </div>

          {/* Transport Type */}
          <div className="flex flex-col gap-1">
            <FieldLabel>{t('mcp.transportType')}</FieldLabel>
            <div className="grid grid-cols-4 gap-1.5">
              {TRANSPORT_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const selected = formData.type === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setFormData({ ...formData, type: opt.key })}
                    className={`flex flex-col items-center gap-1 px-2 py-2 rounded-interactive text-[10px] font-medium border transition-colors ${
                      selected ? 'bg-pure-black text-pure-white border-pure-black' : 'bg-pure-white text-stone border-light-gray hover:border-pure-black'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {opt.key.toUpperCase()}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Stdio fields */}
          {isStdio && (
            <>
              <div className="flex flex-col gap-1">
                <FieldLabel required>{t('mcp.command')}</FieldLabel>
                <input type="text" value={formData.command} onChange={(e) => setFormData({ ...formData, command: e.target.value })} placeholder="e.g. npx or uvx" className={monoFieldCls} />
              </div>
              <div className="flex flex-col gap-1">
                <FieldLabel>{t('mcp.args')}</FieldLabel>
                <textarea
                  value={argsText}
                  onChange={(e) => { setArgsText(e.target.value); validateJson(e.target.value, setArgsValid); }}
                  placeholder={t('mcp.argsPlaceholder')}
                  rows={2}
                  className={`${monoFieldCls} resize-none ${argsValid ? '' : 'border-rose-300 focus:border-rose-500'}`}
                />
                {!argsValid && (
                  <p className="text-[10px] text-rose-500 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{t('mcp.argsInvalid')}</p>
                )}
              </div>
            </>
          )}

          {/* HTTP/SSE fields */}
          {isHttp && (
            <>
              <div className="flex flex-col gap-1">
                <FieldLabel required>{t('mcp.url')}</FieldLabel>
                <input type="text" value={formData.url} onChange={(e) => setFormData({ ...formData, url: e.target.value })} placeholder={t('mcp.urlPlaceholder')} className={monoFieldCls} />
              </div>
              <div className="flex flex-col gap-1">
                <FieldLabel>{t('mcp.headers')}</FieldLabel>
                <textarea
                  value={headersText}
                  onChange={(e) => { setHeadersText(e.target.value); validateJson(e.target.value, setHeadersValid); }}
                  placeholder={t('mcp.headersPlaceholder')}
                  rows={2}
                  className={`${monoFieldCls} resize-none ${headersValid ? '' : 'border-rose-300 focus:border-rose-500'}`}
                />
                {!headersValid && (
                  <p className="text-[10px] text-rose-500 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{t('mcp.headersInvalid')}</p>
                )}
              </div>
            </>
          )}

          {/* ACP fields */}
          {isAcp && (
            <>
              <div className="flex flex-col gap-1">
                <FieldLabel>{t('mcp.agentId')}</FieldLabel>
                <input type="text" value={formData.url} onChange={(e) => setFormData({ ...formData, url: e.target.value })} placeholder={t('mcp.agentIdPlaceholder')} className={monoFieldCls} />
              </div>
              <div className="px-3 py-2 rounded-interactive bg-amber-50 border border-amber-200">
                <p className="text-[11px] text-amber-800 leading-relaxed">{t('mcp.acpDescriptionText')}</p>
              </div>
            </>
          )}

          {/* Env */}
          <div className="flex flex-col gap-1">
            <FieldLabel>{t('mcp.env')}</FieldLabel>
            <textarea
              value={envText}
              onChange={(e) => { setEnvText(e.target.value); validateJson(e.target.value, setEnvValid); }}
              placeholder={t('mcp.envPlaceholder')}
              rows={2}
              className={`${monoFieldCls} resize-none ${envValid ? '' : 'border-rose-300 focus:border-rose-500'}`}
            />
            {!envValid && (
              <p className="text-[10px] text-rose-500 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{t('mcp.envInvalid')}</p>
            )}
          </div>

          {/* OAuth Configuration (for HTTP/SSE) */}
          {isHttp && (
            <div className="space-y-2 pt-2 border-t border-light-gray/30">
              <span className="text-[10px] text-silver font-medium uppercase tracking-wider">OAuth 2.1</span>
              <div className="flex flex-col gap-1">
                <FieldLabel>{t('mcp.oauthClientId')}</FieldLabel>
                <input type="text" value={formData.oauth_client_id || ''} onChange={(e) => setFormData({ ...formData, oauth_client_id: e.target.value || null })} placeholder={t('mcp.oauthClientIdPlaceholder')} className={monoFieldCls} />
              </div>
              <div className="flex flex-col gap-1">
                <FieldLabel>{t('mcp.oauthClientSecret')}</FieldLabel>
                <input type="password" value={formData.oauth_client_secret || ''} onChange={(e) => setFormData({ ...formData, oauth_client_secret: e.target.value || null })} placeholder={t('mcp.oauthClientSecretPlaceholder')} className={monoFieldCls} />
              </div>
              <div className="flex flex-col gap-1">
                <FieldLabel>{t('mcp.oauthScopes')}</FieldLabel>
                <input type="text" value={formData.oauth_scopes?.join(', ') || ''} onChange={(e) => {
                  const scopes = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                  setFormData({ ...formData, oauth_scopes: scopes.length > 0 ? scopes : null });
                }} placeholder={t('mcp.oauthScopesPlaceholder')} className={monoFieldCls} />
              </div>
            </div>
          )}

          {/* Enabled toggle */}
          <div className="flex items-center justify-between py-1">
            <div>
              <span className="text-[13px] text-pure-black">{t('mcp.enabled')}</span>
              <p className="text-[10px] text-silver mt-0.5">{t('mcp.enabledDesc')}</p>
            </div>
            <button
              type="button"
              onClick={() => setFormData({ ...formData, enabled: !formData.enabled })}
              className={`relative w-10 h-[22px] rounded-full transition-colors border shrink-0 ${
                formData.enabled ? 'bg-pure-black border-pure-black' : 'bg-pure-white border-light-gray'
              }`}
            >
              <div className={`absolute top-[2px] w-[18px] h-[18px] rounded-full transition-transform ${
                formData.enabled ? 'left-[18px] bg-pure-white' : 'left-[2px] bg-light-gray'
              }`} />
            </button>
          </div>

          {/* Error */}
          {formError && (
            <div className="flex gap-2 p-2 rounded-interactive bg-rose-50 border border-rose-500/20">
              <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
              <p className="text-[11px] text-rose-800">{formError}</p>
            </div>
          )}

          {/* Test result */}
          {testResult && (
            <div className={`flex gap-2 p-2 rounded-interactive border ${
              testResult.success ? 'bg-emerald-50 border-emerald-600/20' : 'bg-rose-50 border-rose-500/20'
            }`}>
              {testResult.success ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" /> : <XCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />}
              <p className={`text-[11px] ${testResult.success ? 'text-emerald-900' : 'text-rose-800'}`}>{testResult.message}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2 justify-end px-4 py-3 border-t border-light-gray/50 bg-snow">
          <button onClick={onClose} className="px-4 py-2 rounded-interactive text-[13px] font-medium bg-pure-white text-stone hover:bg-light-gray/30 border border-light-gray transition-colors">
            {t('cancel')}
          </button>
          {onTest && (
            <button onClick={onTest} disabled={isTesting} className="px-4 py-2 rounded-interactive text-[13px] font-medium bg-pure-white text-pure-black hover:bg-light-gray/30 border border-light-gray transition-colors disabled:opacity-50">
              {isTesting ? t('mcp.testing') : t('mcp.test')}
            </button>
          )}
          <button onClick={onSave} className="px-4 py-2 rounded-interactive text-[13px] font-medium bg-pure-black text-pure-white hover:bg-near-black transition-colors">
            {t('save')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
