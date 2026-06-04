import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  AlertCircle,
  Wrench,
  Upload,
  RefreshCw,
  X,
  Server,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import type * as Types from '../../lib/backend/types';
import { useAppStore } from '../../lib/store';
import { McpServerDialog } from './McpServerDialog';
import { McpServerRow } from './McpServerRow';
import { McpDetailPanel } from './McpDetailPanel';

// Common MCP server presets
interface McpPreset {
  name: string;
  description: string;
  type: 'stdio' | 'sse' | 'http' | 'acp';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

const MCP_PRESETS: McpPreset[] = [
  {
    name: 'Filesystem',
    description: 'File system access',
    type: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/directory'],
  },
  {
    name: 'GitHub',
    description: 'GitHub API access',
    type: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '<your-token>' },
  },
  {
    name: 'Brave Search',
    description: 'Web search via Brave',
    type: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '<your-key>' },
  },
  {
    name: 'PostgreSQL',
    description: 'PostgreSQL database access',
    type: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'],
  },
  {
    name: 'SQLite',
    description: 'SQLite database access',
    type: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', '/path/to/database.db'],
  },
  {
    name: 'Puppeteer',
    description: 'Browser automation',
    type: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
  },
];

// Detail tab type
type DetailTab = 'tools' | 'resources' | 'prompts';

interface McpSettingsPaneProps {
  workspaceId: string;
}

export function McpSettingsPane({ workspaceId }: McpSettingsPaneProps) {
  const { t } = useTranslation('settings');
  const {
    mcpServers,
    mcpStatuses,
    refreshMcpServers,
    upsertMcpServer,
    deleteMcpServer,
    testMcpConnection,
    importMcpConfigs,
    reloadMcpConnection,
    reloadAllMcpConnections,
    getMcpConnectionStatus,
    updateMcpStatus,
  } = useAppStore();

  // Category tab: 'builtin' | 'custom'
  const [categoryTab, setCategoryTab] = useState<'builtin' | 'custom'>('builtin');

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<'add' | 'edit'>('add');
  const [error, setError] = useState<string | null>(null);

  // Testing state
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());
  const [dialogTesting, setDialogTesting] = useState(false);
  const [lastTestResult, setLastTestResult] = useState<{ id: string; success: boolean; message: string } | null>(null);

  // Expanded server id + active detail tab
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('tools');

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

  // Load MCP servers and initial connection statuses on mount
  useEffect(() => {
    refreshMcpServers();
    getMcpConnectionStatus().catch((err) => {
      console.error('Failed to load MCP connection statuses on mount', err);
    });
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

  // Open dialog with preset
  const openPresetDialog = (preset: McpPreset) => {
    setDialogMode('add');
    setFormData({
      id: uuidv4(),
      workspaceId: workspaceId,
      name: preset.name,
      type: preset.type,
      command: preset.command || '',
      args: preset.args || [],
      url: preset.url || '',
      env: preset.env || {},
      headers: {},
      enabled: true,
      builtin: false,
    });
    setArgsText(JSON.stringify(preset.args, null, 2));
    setEnvText(JSON.stringify(preset.env || {}, null, 2));
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
      if (expandedId === id) setExpandedId(null);
    } catch (err: any) {
      setError(err.message || 'Failed to delete MCP server');
    }
  };

  // Test connection for a single server
  const handleTest = async (server: Types.McpServerConfig) => {
    setTestingIds((prev) => new Set(prev).add(server.id));
    setLastTestResult(null);
    try {
      const status = await testMcpConnection(server);
      updateMcpStatus(workspaceId, status);
      const success = status.status === 'connected';
      const msg = success
        ? t('mcp.testSuccess')
        : `${t('mcp.testFailed')}: ${status.error_message || ''}`;
      setLastTestResult({ id: server.id, success, message: msg });
      setTimeout(() => setLastTestResult(null), 5000);
    } catch (err: any) {
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
      const status = await testMcpConnection(config);
      updateMcpStatus(workspaceId, status);
      const success = status.status === 'connected';
      const msg = success
        ? t('mcp.testSuccess')
        : `${t('mcp.testFailed')}: ${status.error_message || ''}`;
      setDialogTestResult({ success, message: msg });
    } catch (err: any) {
      setFormError(err.message || 'Test failed');
    } finally {
      setDialogTesting(false);
    }
  };

  // Build config from form data
  const buildConfig = (): Types.McpServerConfig => {
    let args: string[];
    try { args = JSON.parse(argsText || '[]'); } catch { args = []; }
    let env: Record<string, string>;
    try { env = JSON.parse(envText || '{}'); } catch { env = {}; }
    let headers: Record<string, string>;
    try { headers = JSON.parse(headersText || '{}'); } catch { headers = {}; }
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
    try {
      const args = JSON.parse(argsText || '[]');
      if (!Array.isArray(args)) { setFormError(t('mcp.argsInvalid')); return; }
    } catch { setFormError(t('mcp.argsInvalid')); return; }
    try {
      const env = JSON.parse(envText || '{}');
      if (typeof env !== 'object' || Array.isArray(env)) { setFormError(t('mcp.envInvalid')); return; }
    } catch { setFormError(t('mcp.envInvalid')); return; }
    if (formData.type === 'http' || formData.type === 'sse') {
      try {
        const h = JSON.parse(headersText || '{}');
        if (typeof h !== 'object' || Array.isArray(h)) { setFormError(t('mcp.headersInvalid')); return; }
      } catch { setFormError(t('mcp.headersInvalid')); return; }
    }
    if (!formData.name.trim()) { setFormError(t('mcp.nameRequired')); return; }
    if (formData.type === 'stdio' && !formData.command.trim()) { setFormError(t('mcp.commandRequired')); return; }
    if ((formData.type === 'http' || formData.type === 'sse') && !formData.url.trim()) { setFormError(t('mcp.urlRequired')); return; }
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
    if (!importText.trim()) { setImportError(t('mcp.importEmpty')); return; }
    try {
      await importMcpConfigs(importText);
      setImportOpen(false);
      setImportText('');
    } catch (err: any) {
      setImportError(err.message || 'Import failed');
    }
  };

  // Toggle expand/collapse
  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
    setDetailTab('tools');
  };

  // Switch category tab and collapse any expanded server
  const switchCategoryTab = (tab: 'builtin' | 'custom') => {
    setCategoryTab(tab);
    setExpandedId(null);
  };

  // Include builtin MCPs (which have empty workspaceId) alongside workspace-specific ones
  const allServers = mcpServers.filter((s) => s.workspaceId === workspaceId || s.builtin);
  const builtinServers = allServers.filter((s) => s.builtin);
  const customServers = allServers.filter((s) => !s.builtin);
  const servers = categoryTab === 'builtin' ? builtinServers : customServers;

  const connectedCount = allServers.filter(s => mcpStatuses.get(s.id)?.status === 'connected').length;
  const errorCount = allServers.filter(s => mcpStatuses.get(s.id)?.status === 'error').length;
  const disabledCount = allServers.filter(s => !s.enabled).length;
  const totalTools = allServers.reduce((acc, s) => {
    const status = mcpStatuses.get(s.id);
    return acc + (status?.tools.filter(t => t.name).length || 0);
  }, 0);

  // -- Main render --
  return (
    <div className="space-y-6">
      {/* Error banner */}
      {error && (
        <div className="flex gap-2 p-2.5 rounded-interactive bg-rose-50 border border-rose-500/20">
          <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0 mt-0.5" />
          <p className="text-[11px] text-rose-800 leading-relaxed flex-1">{error}</p>
          <button onClick={() => setError(null)} className="text-rose-500 hover:text-rose-800 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Servers List */}
      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          {/* Left: "Servers" label + Status summary + Reload */}
          <div className="flex items-center gap-2">
            <div className="text-[10px] text-silver font-medium uppercase tracking-wider">{t('mcp.servers')}</div>

            {(connectedCount > 0 || errorCount > 0 || disabledCount > 0 || totalTools > 0) && (
              <>
                <div className="w-px h-3 bg-light-gray" />
                <div className="flex items-center gap-2.5">
                  {connectedCount > 0 && (
                    <div className="flex items-center gap-1 text-[11px]">
                      <div className="w-1.5 h-1.5 rounded-full bg-[#10b981]" />
                      <span className="text-pure-black font-medium">{connectedCount} {t('mcp.connected')}</span>
                    </div>
                  )}
                  {errorCount > 0 && (
                    <div className="flex items-center gap-1 text-[11px]">
                      <div className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                      <span className="text-rose-500 font-medium">{errorCount} {t('mcp.error')}</span>
                    </div>
                  )}
                  {disabledCount > 0 && (
                    <div className="flex items-center gap-1 text-[11px]">
                      <div className="w-1.5 h-1.5 rounded-full bg-light-gray" />
                      <span className="text-silver font-medium">{disabledCount} {t('mcp.disabled')}</span>
                    </div>
                  )}
                  {totalTools > 0 && (
                    <div className="flex items-center gap-1 text-[11px]">
                      <Wrench className="w-3 text-stone" />
                      <span className="text-stone font-medium">{totalTools} {t('mcp.tools')}</span>
                    </div>
                  )}
                </div>
              </>
            )}

            <button
              onClick={() => reloadAllMcpConnections()}
              className="p-1 rounded hover:bg-light-gray/30 text-stone hover:text-pure-black transition-colors"
              title={t('mcp.reloadAll')}
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>

          {/* Right: Import + Add */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setImportOpen(true)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-interactive text-[11px] font-medium text-stone hover:text-pure-black hover:bg-light-gray/30 transition-colors"
            >
              <Upload className="w-3 h-3" />
              <span>{t('mcp.import')}</span>
            </button>
            <button
              onClick={openAddDialog}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-interactive text-[11px] font-medium bg-pure-black text-pure-white hover:bg-near-black transition-colors"
            >
              <Plus className="w-3 h-3" />
              {t('mcp.add')}
            </button>
          </div>
        </div>

        <div className="border border-light-gray/60 rounded-container overflow-hidden bg-pure-white">
          {/* Category Tab: Built-in / Custom — inside the list container as header */}
          <div className="flex gap-1 p-2 border-b border-light-gray/30 bg-snow/40">
            <button
              onClick={() => switchCategoryTab('builtin')}
              className={`px-3 py-1.5 text-[12px] font-medium rounded-interactive transition-colors ${
                categoryTab === 'builtin'
                  ? 'bg-light-gray text-near-black'
                  : 'bg-transparent text-stone hover:text-pure-black'
              }`}
            >
              {t('mcp.builtinTab')}
            </button>
            <button
              onClick={() => switchCategoryTab('custom')}
              className={`px-3 py-1.5 text-[12px] font-medium rounded-interactive transition-colors ${
                categoryTab === 'custom'
                  ? 'bg-light-gray text-near-black'
                  : 'bg-transparent text-stone hover:text-pure-black'
              }`}
            >
              {t('mcp.customTab')}
            </button>
          </div>

          {servers.length === 0 ? (
            /* Empty state */
            categoryTab === 'custom' ? (
              /* Custom tab: show preset suggestions */
              <div className="p-6">
                <div className="text-center mb-4">
                  <Server className="w-8 h-8 text-light-gray mx-auto mb-2" />
                  <p className="text-[13px] text-stone font-medium">{t('mcp.noCustomServers')}</p>
                  <p className="text-[11px] text-silver mt-1">{t('mcp.noCustomServersDesc')}</p>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {MCP_PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      onClick={() => openPresetDialog(preset)}
                      className="flex flex-col items-start px-3 py-2.5 rounded-interactive border border-light-gray/60 hover:border-pure-black hover:bg-snow transition-colors text-left"
                    >
                      <span className="text-[12px] font-medium text-pure-black">{preset.name}</span>
                      <span className="text-[10px] text-silver mt-0.5">{preset.description}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              /* Builtin tab: simple empty message */
              <div className="p-6 text-center">
                <Server className="w-8 h-8 text-light-gray mx-auto mb-2" />
                <p className="text-[13px] text-stone font-medium">{t('mcp.noBuiltinServers')}</p>
              </div>
            )
          ) : (
            <div>
              {servers.map((server, index) => {
              const isExpanded = expandedId === server.id;
              const status = mcpStatuses.get(server.id);
              const isConnected = status?.status === 'connected';
              const isBuiltin = server.builtin;
              const realTools = status?.tools.filter((t) => t.name) || [];

              return (
                <div key={server.id} className={index !== servers.length - 1 ? 'border-b border-light-gray/30' : ''}>
                  <McpServerRow
                    server={server}
                    status={status}
                    isExpanded={isExpanded}
                    isConnected={isConnected}
                    isBuiltin={isBuiltin}
                    realTools={realTools}
                    isTesting={testingIds.has(server.id)}
                    lastTestResult={lastTestResult}
                    onToggleExpand={() => isConnected ? toggleExpand(server.id) : undefined}
                    onTest={() => handleTest(server)}
                    onEdit={() => openEditDialog(server)}
                    onDelete={() => handleDelete(server.id)}
                    onToggle={() => handleToggle(server)}
                    t={t}
                  />
                  {isExpanded && status && status.status === 'connected' && (
                    <McpDetailPanel
                      server={server}
                      status={status}
                      detailTab={detailTab}
                      onSetDetailTab={setDetailTab}
                      t={t}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
        </div>
      </section>

      {/* JSON Import Modal */}
      {importOpen && (
        <div data-settings-child-dialog className="fixed inset-0 bg-pure-black/20 z-[110] flex items-center justify-center">
          <div className="absolute inset-0" onClick={() => setImportOpen(false)} />
          <div className="relative z-10 w-full max-w-lg bg-pure-white rounded-container border border-light-gray shadow-lg overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-light-gray/50">
              <div>
                <h2 className="font-display font-medium text-[14px] text-pure-black">{t('mcp.import')}</h2>
                <p className="text-[11px] text-stone mt-0.5">{t('mcp.importDescription')}</p>
              </div>
              <button onClick={() => setImportOpen(false)} className="p-1 rounded-interactive text-stone hover:text-pure-black hover:bg-light-gray/30 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-4 py-4">
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder='{"mcpServers": {"server-name": {"command": "npx", "args": ["-y", "pkg"]}}}'
                rows={10}
                className="w-full px-3 py-2 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors font-mono resize-none"
                autoFocus
              />
              {importError && (
                <div className="flex gap-2 p-2 mt-2 rounded-interactive bg-rose-50 border border-rose-500/20">
                  <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                  <p className="text-[11px] text-rose-800">{importError}</p>
                </div>
              )}
            </div>
            <div className="flex gap-2 justify-end px-4 py-3 border-t border-light-gray/50 bg-snow">
              <button onClick={() => setImportOpen(false)} className="px-4 py-2 rounded-interactive text-[13px] font-medium bg-pure-white text-stone hover:bg-light-gray/30 border border-light-gray transition-colors">
                {t('cancel')}
              </button>
              <button onClick={handleImport} className="px-4 py-2 rounded-interactive text-[13px] font-medium bg-pure-black text-pure-white hover:bg-near-black transition-colors">
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
