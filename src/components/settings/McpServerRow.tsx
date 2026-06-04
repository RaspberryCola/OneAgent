import { useState, useEffect } from 'react';
import { Loader2, RefreshCw, Pencil, Trash2, Lock, Wrench, ChevronDown, ChevronRight, CheckCircle2, XCircle } from 'lucide-react';
import type * as Types from '../../lib/backend/types';

// Transport type visual config
const TRANSPORT_META: Record<string, { color: string; bg: string }> = {
  stdio: { color: 'text-stone', bg: 'bg-light-gray/40' },
  sse: { color: 'text-blue-600', bg: 'bg-blue-50' },
  http: { color: 'text-violet-600', bg: 'bg-violet-50' },
  acp: { color: 'text-amber-600', bg: 'bg-amber-50' },
};

interface McpServerRowProps {
  server: Types.McpServerConfig;
  status?: Types.McpServerStatus;
  isExpanded: boolean;
  isConnected: boolean;
  isBuiltin: boolean;
  realTools: Types.McpToolInfo[];
  isTesting: boolean;
  lastTestResult?: { id: string; success: boolean; message: string } | null;
  onToggleExpand: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  t: (key: string) => string;
}

export function McpServerRow({
  server,
  status,
  isExpanded,
  isConnected,
  isBuiltin,
  realTools,
  isTesting,
  lastTestResult,
  onToggleExpand,
  onTest,
  onEdit,
  onDelete,
  onToggle,
  t,
}: McpServerRowProps) {
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [confirmTimer, setConfirmTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  // Reset confirm state when server changes
  useEffect(() => {
    setShowDisableConfirm(false);
    if (confirmTimer) {
      clearTimeout(confirmTimer);
      setConfirmTimer(null);
    }
  }, [server.enabled]);

  const handleToggle = () => {
    // If disabling a connected server with tools, require confirmation
    if (server.enabled && isConnected && realTools.length > 0) {
      if (!showDisableConfirm) {
        setShowDisableConfirm(true);
        const timer = setTimeout(() => {
          setShowDisableConfirm(false);
          setConfirmTimer(null);
        }, 3000);
        setConfirmTimer(timer);
        return;
      }
      // User confirmed, proceed with toggle
      setShowDisableConfirm(false);
      if (confirmTimer) {
        clearTimeout(confirmTimer);
        setConfirmTimer(null);
      }
    }
    onToggle();
  };

  const TransportBadge = ({ type }: { type: string }) => {
    const meta = TRANSPORT_META[type] || TRANSPORT_META.stdio;
    return (
      <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide ${meta.bg} ${meta.color}`}>
        {type}
      </span>
    );
  };

  const StatusDot = () => {
    if (!status || !server.enabled) return <div className="w-2 h-2 rounded-full bg-light-gray" />;
    switch (status.status) {
      case 'connected': return <div className="w-2 h-2 rounded-full bg-[#10b981]" />;
      case 'connecting': return <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />;
      case 'error': return <div className="w-2 h-2 rounded-full bg-rose-500" />;
      default: return <div className="w-2 h-2 rounded-full bg-light-gray" />;
    }
  };

  return (
    <div className="flex items-center gap-3 py-3 px-4 hover:bg-snow/80 transition-colors">
      {/* Expand toggle */}
      <button
        onClick={onToggleExpand}
        className={`shrink-0 w-5 h-5 flex items-center justify-center rounded transition-colors ${
          isConnected ? 'text-stone hover:text-pure-black cursor-pointer' : 'text-light-gray cursor-default'
        }`}
      >
        {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      </button>

      {/* Status dot */}
      <StatusDot />

      {/* Name + transport + meta (clickable area) */}
      <div
        className="flex-1 min-w-0 cursor-pointer"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-2">
          <span className="font-display font-medium text-[13px] text-pure-black truncate">{server.name}</span>
          <TransportBadge type={server.type} />
          {isBuiltin && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-light-gray/30 text-[9px] text-silver font-medium">
              <Lock className="w-2.5 h-2.5" /> {t('mcp.builtin')}
            </span>
          )}
          {isConnected && realTools.length > 0 && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-600 font-medium">
              <Wrench className="w-3 h-3" /> {realTools.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="font-mono text-[10px] text-silver truncate">
            {server.type === 'stdio'
              ? `${server.command}${server.args?.length ? ' ' + server.args.join(' ') : ''}`
              : server.url}
          </span>
          {/* Test result feedback */}
          {lastTestResult?.id === server.id && (
            <span className={`text-[10px] flex items-center gap-0.5 ${lastTestResult.success ? 'text-emerald-600' : 'text-rose-500'}`}>
              {lastTestResult.success ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
              {lastTestResult.message}
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={onTest}
          disabled={isTesting}
          className="p-1.5 rounded-interactive text-silver hover:text-pure-black hover:bg-light-gray/30 transition-colors disabled:opacity-50"
          title={t('mcp.test')}
        >
          {isTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </button>
        {!isBuiltin && (
          <>
            <button
              onClick={onEdit}
              className="p-1.5 rounded-interactive text-silver hover:text-pure-black hover:bg-light-gray/30 transition-colors"
              title={t('mcp.edit')}
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onDelete}
              className="p-1.5 rounded-interactive text-silver hover:text-rose-500 hover:bg-rose-50 transition-colors"
              title={t('mcp.delete')}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </>
        )}
        <div className="w-px h-5 bg-light-gray/30 mx-1" />
        <div className="flex items-center gap-1.5">
          {showDisableConfirm && (
            <span className="text-[10px] text-rose-500 font-medium animate-pulse">{t('mcp.disableConfirm')}</span>
          )}
          <button
            onClick={handleToggle}
            className={`relative w-10 h-[22px] rounded-full transition-colors border shrink-0 ${
              server.enabled ? 'bg-pure-black border-pure-black' : 'bg-pure-white border-light-gray'
            } ${showDisableConfirm ? 'ring-2 ring-rose-300' : ''}`}
          >
            <div className={`absolute top-[2px] w-[18px] h-[18px] rounded-full transition-transform ${
              server.enabled ? 'left-[18px] bg-pure-white' : 'left-[2px] bg-light-gray'
            }`} />
          </button>
        </div>
      </div>
    </div>
  );
}
