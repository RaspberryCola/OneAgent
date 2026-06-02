import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  Pencil,
  Trash2,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Loader2,
  Wrench,
  Lock,
  Upload,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  X,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import type * as Types from '../../lib/backend/types';
import { useAppStore } from '../../lib/store';
import { onMcpStatusChanged } from '../../lib/backend/events';
import { McpServerDialog } from './McpServerDialog';

interface McpSettingsPaneProps {
  workspaceId: string;
}

export function McpSettingsPane({ workspaceId }: McpSettingsPaneProps) {
  const { t } = useTranslation('settings');
  const {
    mcpServers,
    refreshMcpServers,
    upsertMcpServer,
    deleteMcpServer,
    testMcpConnection,
    importMcpConfigs,
  } = useAppStore();

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<'add' | 'edit'>('add');
  const [error, setError] = useState<string | null>(null);

  // MCP status state - keyed by config_id
  const [mcpStatuses, setMcpStatuses] = useState<Map<string, Types.McpServerStatus>>(new Map());

  // Testing state
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());
  const [dialogTesting, setDialogTesting] = useState(false);
  // Last test result for inline feedback (auto-clears after 5s)
  const [lastTestResult, setLastTestResult] = useState<{ id: string; success: boolean; message: string } | null>(null);

  // Expanded server ids (for tool list)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // JSON import state
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);

  // Form state for editing/adding
  const [formData, setFormData] = useState<Types.McpServerConfig>({
    id: '',
    workspaceId: workspaceId,
    name: '',
    type: 'stdio',
    command: '',
    args: [],
    url: '',
    env: {},
    headers: {},
    enabled: true,
    builtin: false,
  });
  const [argsText, setArgsText] = useState('[]');
  const [envText, setEnvText] = useState('{}');
  const [headersText, setHeadersText] = useState('{}');
  const [formError, setFormError] = useState<string | null>(null);

  // Load MCP servers on mount
  useEffect(() => {
    refreshMcpServers();
  }, [workspaceId]);

  // Subscribe to MCP status changes
  useEffect(() => {
    const unlisten = onMcpStatusChanged((payload) => {
      if (payload.workspace_id === workspaceId) {
        setMcpStatuses((prev) => {
          const next = new Map(prev);
          next.set(payload.status.config_id, payload.status);
          return next;
        });
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [workspaceId]);

  // Open dialog for adding
  const openAddDialog = () => {
    setDialogMode('add');
    setFormData({
      id: uuidv4(),
      workspaceId: workspaceId,
      name: '',
      type: 'stdio',
      command: '',
      args: [],
      url: '',
      env: {},
      headers: {},
      enabled: true,
      builtin: false,
    });
    setArgsText('[]');
    setEnvText('{}');
    setHeadersText('{}');
    setFormError(null);
    setDialogOpen(true);
  };

  // Open dialog for editing
  const openEditDialog = (server: Types.McpServerConfig) => {
    setDialogMode('edit');
    setFormData(server);
    setArgsText(JSON.stringify(server.args, null, 2));
    setEnvText(JSON.stringify(server.env, null, 2));
    setHeadersText(JSON.stringify(server.headers ?? {}, null, 2));
    setFormError(null);
    setDialogOpen(true);
  };

  // Close dialog
  const closeDialog = () => {
    setDialogOpen(false);
    setFormError(null);
  };

  // Toggle enabled
  const handleToggle = async (server: Types.McpServerConfig) => {
    try {
      await upsertMcpServer({ ...server, enabled: !server.enabled });
    } catch (err: any) {
      setError(err.message || 'Failed to toggle MCP server');
    }
  };

  // Delete server
  const handleDelete = async (id: string) => {
    try {
      await deleteMcpServer(id);
    } catch (err: any) {
      setError(err.message || 'Failed to delete MCP server');
    }
  };

  // Test connection for a single server
  const handleTest = async (server: Types.McpServerConfig) => {
    setTestingIds((prev) => new Set(prev).add(server.id));
    setLastTestResult(null);
    try {
      console.log('[MCP] Testing connection for:', server.name, server.type, server.type === 'stdio' ? server.command : server.url);
      const status = await testMcpConnection(server);
      console.log('[MCP] Test result:', status);
      setMcpStatuses((prev) => new Map(prev).set(server.id, status));
      const success = status.status === 'connected';
      const msg = success
        ? t('mcp.testSuccess')
        : `${t('mcp.testFailed')}: ${status.error_message || ''}`;
      setLastTestResult({ id: server.id, success, message: msg });
      // Auto-clear after 5s
      setTimeout(() => setLastTestResult(null), 5000);
    } catch (err: any) {
      console.error('[MCP] Test error:', err);
      setError(err.message || 'Test failed');
    } finally {
      setTestingIds((prev) => {
        const next = new Set(prev);
        next.delete(server.id);
        return next;
      });
    }
  };

  // Test from dialog
  const [dialogTestResult, setDialogTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleDialogTest = async () => {
    setDialogTesting(true);
    setDialogTestResult(null);
    setFormError(null);
    try {
      const config = buildConfig();
      console.log('[MCP] Dialog test for:', config.name, config.type, config.type === 'stdio' ? config.command : config.url);
      const status = await testMcpConnection(config);
      console.log('[MCP] Dialog test result:', status);
      // Update mcpStatuses for when the server gets saved
      setMcpStatuses((prev) => new Map(prev).set(config.id, status));
      const success = status.status === 'connected';
      const msg = success
        ? t('mcp.testSuccess')
        : `${t('mcp.testFailed')}: ${status.error_message || ''}`;
      setDialogTestResult({ success, message: msg });
    } catch (err: any) {
      console.error('[MCP] Dialog test error:', err);
      setFormError(err.message || 'Test failed');
    } finally {
      setDialogTesting(false);
    }
  };

  // Build config from form data
  const buildConfig = (): Types.McpServerConfig => {
    let args: string[];
    try {
      args = JSON.parse(argsText || '[]');
    } catch {
      args = [];
    }
    let env: Record<string, string>;
    try {
      env = JSON.parse(envText || '{}');
    } catch {
      env = {};
    }
    let headers: Record<string, string>;
    try {
      headers = JSON.parse(headersText || '{}');
    } catch {
      headers = {};
    }
    return {
      id: formData.id || uuidv4(),
      workspaceId,
      name: formData.name.trim(),
      type: formData.type,
      command: formData.command.trim(),
      args,
      url: formData.url.trim(),
      env,
      headers,
      enabled: formData.enabled,
      builtin: formData.builtin ?? false,
    };
  };

  // Save form
  const handleSave = async () => {
    // Validate JSON fields
    try {
      const args = JSON.parse(argsText || '[]');
      if (!Array.isArray(args)) {
        setFormError(t('mcp.argsInvalid'));
        return;
      }
    } catch {
      setFormError(t('mcp.argsInvalid'));
      return;
    }
    try {
      const env = JSON.parse(envText || '{}');
      if (typeof env !== 'object' || Array.isArray(env)) {
        setFormError(t('mcp.envInvalid'));
        return;
      }
    } catch {
      setFormError(t('mcp.envInvalid'));
      return;
    }
    if (formData.type === 'http' || formData.type === 'sse') {
      try {
        const h = JSON.parse(headersText || '{}');
        if (typeof h !== 'object' || Array.isArray(h)) {
          setFormError(t('mcp.headersInvalid'));
          return;
        }
      } catch {
        setFormError(t('mcp.headersInvalid'));
        return;
      }
    }

    // Validate required fields
    if (!formData.name.trim()) {
      setFormError(t('mcp.nameRequired'));
      return;
    }
    if (formData.type === 'stdio' && !formData.command.trim()) {
      setFormError(t('mcp.commandRequired'));
      return;
    }
    if ((formData.type === 'http' || formData.type === 'sse') && !formData.url.trim()) {
      setFormError(t('mcp.urlRequired'));
      return;
    }

    try {
      const config = buildConfig();
      await upsertMcpServer(config);
      closeDialog();
    } catch (err: any) {
      setFormError(err.message || 'Failed to save MCP server');
    }
  };

  // JSON import
  const handleImport = async () => {
    setImportError(null);
    if (!importText.trim()) {
      setImportError(t('mcp.importEmpty'));
      return;
    }
    try {
      await importMcpConfigs(importText);
      setImportOpen(false);
      setImportText('');
    } catch (err: any) {
      setImportError(err.message || 'Import failed');
    }
  };

  // Toggle expand/collapse for tool list
  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const servers = mcpServers.filter((s) => s.workspaceId === workspaceId);

  // Render status indicator
  const renderStatusIndicator = (server: Types.McpServerConfig) => {
    const status = mcpStatuses.get(server.id);
    if (!status || !server.enabled) return null;

    const { status: connStatus, tools, error_message } = status;
    const realTools = tools.filter((t) => t.name);

    switch (connStatus) {
      case 'connected':
        return (
          <div className="flex items-center gap-1.5 text-green-600">
            <CheckCircle2 className="w-3.5 h-3.5" />
            {realTools.length > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] font-medium">
                <Wrench className="w-3 h-3" />
                {realTools.length}
              </span>
            )}
          </div>
        );
      case 'connecting':
        return (
          <div className="flex items-center gap-1 text-silver">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          </div>
        );
      case 'error':
        return (
          <div className="flex items-center gap-1 text-red-500" title={error_message || undefined}>
            <XCircle className="w-3.5 h-3.5" />
          </div>
        );
      case 'disconnected':
        return (
          <div className="flex items-center gap-1 text-silver">
            <XCircle className="w-3.5 h-3.5" />
          </div>
        );
      default:
        return null;
    }
  };

  // Render tool list for a connected server
  const renderToolList = (server: Types.McpServerConfig) => {
    const status = mcpStatuses.get(server.id);
    if (!status || status.status !== 'connected') return null;
    const realTools = status.tools.filter((t) => t.name);
    return (
      <div className="px-4 pb-3 space-y-1.5">
        {realTools.length > 0 ? (
          realTools.map((tool, idx) => (
            <div
              key={idx}
              className="flex items-start gap-3 px-3 py-2 rounded-interactive bg-snow border border-light-gray/20"
            >
              <span className="font-mono text-[11px] font-medium text-pure-black shrink-0 min-w-0 w-1/3 break-words">
                {tool.name}
              </span>
              <span className="text-[11px] text-stone leading-relaxed truncate" title={tool.description || undefined}>
                {tool.description || t('mcp.noDescription')}
              </span>
            </div>
          ))
        ) : (
          <div className="px-3 py-2 text-[11px] text-silver">
            {t('mcp.testSuccess')} — {t('mcp.noToolsDiscovered')}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header with Add + Import buttons */}
      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="text-[10px] text-silver font-medium uppercase tracking-wider">
            {t('mcp.title')}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setImportOpen(true)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-interactive text-[12px] font-medium bg-pure-white text-stone border border-light-gray hover:border-pure-black hover:text-pure-black transition-colors"
            >
              <Upload className="w-3.5 h-3.5" />
              {t('mcp.import')}
            </button>
            <button
              onClick={openAddDialog}
              className="flex items-center gap-1 px-3 py-1.5 rounded-interactive text-[12px] font-medium bg-pure-black text-pure-white hover:bg-near-black transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('mcp.add')}
            </button>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="flex gap-3 p-3 mb-3 rounded-container bg-snow border border-light-gray/20">
            <AlertCircle className="w-3.5 h-3.5 text-stone shrink-0 mt-0.5" />
            <p className="text-[11px] text-stone leading-relaxed">{error}</p>
          </div>
        )}

        {/* Server list */}
        {servers.length === 0 ? (
          <div className="border border-light-gray/60 rounded-container overflow-hidden bg-pure-white">
            <div className="flex items-center justify-center py-8 text-[12px] text-stone">
              {t('mcp.noServers')}
            </div>
          </div>
        ) : (
          <div className="border border-light-gray/60 rounded-container overflow-hidden bg-pure-white">
            {servers.map((server, index) => {
              const isExpanded = expandedIds.has(server.id);
              const status = mcpStatuses.get(server.id);
              const isConnected = status?.status === 'connected';
              const isBuiltin = server.builtin;

              return (
                <div
                  key={server.id}
                  className={`${index !== servers.length - 1 ? 'border-b border-light-gray/30' : ''}`}
                >
                  <div className="flex items-center justify-between py-3 px-4 hover:bg-snow transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      {/* Expand toggle (only if connected) */}
                      {isConnected ? (
                        <button
                          onClick={() => toggleExpand(server.id)}
                          className="shrink-0 text-stone hover:text-pure-black transition-colors"
                        >
                          {isExpanded ? (
                            <ChevronDown className="w-3.5 h-3.5" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5" />
                          )}
                        </button>
                      ) : (
                        <div className="shrink-0 w-3.5" />
                      )}

                      {/* Status indicator */}
                      <div className="shrink-0 w-5">{renderStatusIndicator(server)}</div>

                      <div className="flex flex-col gap-0.5 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-display font-medium text-[13px] text-pure-black truncate">
                            {server.name}
                          </span>
                          {isBuiltin && (
                            <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-snow text-[9px] text-silver font-medium">
                              <Lock className="w-2.5 h-2.5" />
                              {t('mcp.builtin')}
                            </span>
                          )}
                        </div>
                        <span className="font-mono text-[10px] text-silver truncate">
                          {server.type === 'stdio'
                            ? `${server.command} ${Array.isArray(server.args) && server.args.length > 0 ? server.args.join(' ') : ''}`
                            : server.url}
                        </span>
                        {/* Test result feedback */}
                        {lastTestResult?.id === server.id && (
                          <span className={`text-[10px] ${lastTestResult.success ? 'text-green-600' : 'text-red-500'}`}>
                            {lastTestResult.message}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {/* Test connection */}
                      {!isBuiltin && (
                        <button
                          onClick={() => handleTest(server)}
                          disabled={testingIds.has(server.id)}
                          className="p-1.5 rounded-interactive text-stone hover:text-pure-black hover:bg-light-gray/30 transition-colors disabled:opacity-50"
                          title={t('mcp.test')}
                        >
                          {testingIds.has(server.id) ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}

                      {/* Toggle */}
                      <button
                        onClick={() => handleToggle(server)}
                        className={`relative w-12 h-7 rounded-full transition-colors border ${
                          server.enabled
                            ? 'bg-pure-black border-pure-black'
                            : 'bg-pure-white border-light-gray'
                        }`}
                      >
                        <div
                          className={`absolute top-[1px] w-6 h-6 rounded-full transition-transform ${
                            server.enabled ? 'left-[22px] bg-pure-white' : 'left-[2px] bg-light-gray'
                          }`}
                        />
                      </button>

                      {/* Edit (hidden for builtin) */}
                      {!isBuiltin && (
                        <button
                          onClick={() => openEditDialog(server)}
                          className="p-1.5 rounded-interactive text-stone hover:text-pure-black hover:bg-light-gray/30 transition-colors"
                          title={t('mcp.edit')}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}

                      {/* Delete (hidden for builtin) */}
                      {!isBuiltin && (
                        <button
                          onClick={() => handleDelete(server.id)}
                          className="p-1.5 rounded-interactive text-stone hover:text-pure-black hover:bg-light-gray/30 transition-colors"
                          title={t('mcp.delete')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expanded tool list */}
                  {isExpanded && renderToolList(server)}
                </div>
              );
            })}
          </div>
        )}
      </section>


      {/* JSON Import Modal */}
      {importOpen && (
        <div data-settings-child-dialog className="fixed inset-0 bg-pure-black/20 z-[110] flex items-center justify-center">
          <div className="absolute inset-0" onClick={() => setImportOpen(false)} />
          <div className="relative z-10 w-full max-w-lg bg-pure-white rounded-container border border-light-gray shadow-lg overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-light-gray/50">
              <h2 className="font-display font-medium text-[14px] text-pure-black">
                {t('mcp.import')}
              </h2>
              <button
                onClick={() => setImportOpen(false)}
                className="p-1 rounded-interactive text-stone hover:text-pure-black hover:bg-light-gray/30 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-4 py-4 space-y-3">
              <p className="text-[12px] text-stone">{t('mcp.importDescription')}</p>
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder='{"mcpServers": {"server-name": {"command": "npx", "args": ["-y", "pkg"]}}}'
                rows={10}
                className="w-full px-3 py-2 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors font-mono resize-none"
              />
              {importError && (
                <div className="flex gap-2 p-2 rounded-interactive bg-snow border border-light-gray/20">
                  <AlertCircle className="w-3.5 h-3.5 text-stone shrink-0" />
                  <p className="text-[11px] text-stone">{importError}</p>
                </div>
              )}
            </div>
            <div className="flex gap-2 justify-end px-4 py-3 border-t border-light-gray/50 bg-snow">
              <button
                onClick={() => setImportOpen(false)}
                className="px-4 py-2 rounded-interactive text-[13px] font-medium bg-pure-white text-stone hover:bg-light-gray/30 border border-light-gray transition-colors"
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleImport}
                className="px-4 py-2 rounded-interactive text-[13px] font-medium bg-pure-black text-pure-white hover:bg-near-black transition-colors"
              >
                {t('mcp.import')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dialog */}
      <McpServerDialog
        isOpen={dialogOpen}
        mode={dialogMode}
        workspaceId={workspaceId}
        formData={formData}
        setFormData={setFormData}
        argsText={argsText}
        setArgsText={setArgsText}
        envText={envText}
        setEnvText={setEnvText}
        headersText={headersText}
        setHeadersText={setHeadersText}
        formError={formError}
        testResult={dialogTestResult}
        onSave={handleSave}
        onClose={() => { closeDialog(); setDialogTestResult(null); }}
        onTest={handleDialogTest}
        isTesting={dialogTesting}
      />
    </div>
  );
}
