import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2, AlertCircle, CheckCircle2, XCircle, Loader2, Wrench } from 'lucide-react';
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
  const { mcpServers, refreshMcpServers, upsertMcpServer, deleteMcpServer } = useAppStore();

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<'add' | 'edit'>('add');
  const [error, setError] = useState<string | null>(null);

  // MCP status state - keyed by config_id
  const [mcpStatuses, setMcpStatuses] = useState<Map<string, Types.McpServerStatus>>(new Map());

  // Form state for editing/adding
  const [formData, setFormData] = useState<Types.McpServerConfig>({
    id: '',
    workspace_id: workspaceId,
    name: '',
    command: '',
    args_json: [],
    env_json: {},
    enabled: true,
  });
  const [argsText, setArgsText] = useState('[]');
  const [envText, setEnvText] = useState('{}');
  const [formError, setFormError] = useState<string | null>(null);

  // Load MCP servers on mount
  useEffect(() => {
    refreshMcpServers();
  }, [workspaceId]);

  // Subscribe to MCP status changes
  useEffect(() => {
    const unlisten = onMcpStatusChanged((payload) => {
      if (payload.workspace_id === workspaceId) {
        setMcpStatuses(prev => {
          const next = new Map(prev);
          next.set(payload.status.config_id, payload.status);
          return next;
        });
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, [workspaceId]);

  // Open dialog for adding
  const openAddDialog = () => {
    setDialogMode('add');
    setFormData({
      id: uuidv4(),
      workspace_id: workspaceId,
      name: '',
      command: '',
      args_json: [],
      env_json: {},
      enabled: true,
    });
    setArgsText('[]');
    setEnvText('{}');
    setFormError(null);
    setDialogOpen(true);
  };

  // Open dialog for editing
  const openEditDialog = (server: Types.McpServerConfig) => {
    setDialogMode('edit');
    setFormData(server);
    setArgsText(JSON.stringify(server.args_json, null, 2));
    setEnvText(JSON.stringify(server.env_json, null, 2));
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

  // Save form
  const handleSave = async () => {
    // Validate JSON
    let args_json: any[];
    let env_json: Record<string, string>;

    try {
      args_json = JSON.parse(argsText || '[]');
      if (!Array.isArray(args_json)) {
        setFormError(t('mcp.argsInvalid'));
        return;
      }
    } catch {
      setFormError(t('mcp.argsInvalid'));
      return;
    }

    try {
      env_json = JSON.parse(envText || '{}');
      if (typeof env_json !== 'object' || Array.isArray(env_json)) {
        setFormError(t('mcp.envInvalid'));
        return;
      }
    } catch {
      setFormError(t('mcp.envInvalid'));
      return;
    }

    // Validate required fields
    if (!formData.name.trim()) {
      setFormError(t('mcp.nameRequired'));
      return;
    }
    if (!formData.command.trim()) {
      setFormError(t('mcp.commandRequired'));
      return;
    }

    try {
      const config: Types.McpServerConfig = {
        id: formData.id || uuidv4(),
        workspace_id: workspaceId,
        name: formData.name.trim(),
        command: formData.command.trim(),
        args_json,
        env_json,
        enabled: formData.enabled,
      };
      await upsertMcpServer(config);
      closeDialog();
    } catch (err: any) {
      setFormError(err.message || 'Failed to save MCP server');
    }
  };

  const servers = mcpServers.filter(s => s.workspace_id === workspaceId);

  // Helper to render status indicator
  const renderStatusIndicator = (server: Types.McpServerConfig) => {
    const status = mcpStatuses.get(server.id);
    if (!status || !server.enabled) {
      return null;
    }

    const { status: connStatus, tools, error_message } = status;

    switch (connStatus) {
      case 'connected':
        return (
          <div className="flex items-center gap-1.5 text-green-600">
            <CheckCircle2 className="w-3.5 h-3.5" />
            {tools.length > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] font-medium">
                <Wrench className="w-3 h-3" />
                {tools.length}
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
          <div className="flex items-center gap-1 text-red-500">
            <XCircle className="w-3.5 h-3.5" />
            {error_message && (
              <span className="text-[10px] truncate max-w-[80px]" title={error_message}>
                {t('mcp.status.error')}
              </span>
            )}
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

  return (
    <div className="space-y-6">
      {/* Header with Add button */}
      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="text-[10px] text-silver font-medium uppercase tracking-wider">
            {t('mcp.title')}
          </div>
          <button
            onClick={openAddDialog}
            className="flex items-center gap-1 px-3 py-1.5 rounded-interactive text-[12px] font-medium bg-pure-black text-pure-white hover:bg-near-black transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('mcp.add')}
          </button>
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
            {servers.map((server, index) => (
              <div
                key={server.id}
                className={`${index !== servers.length - 1 ? 'border-b border-light-gray/30' : ''}`}
              >
                <div className="flex items-center justify-between py-3 px-4 hover:bg-snow transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Status indicator */}
                    <div className="shrink-0 w-5">
                      {renderStatusIndicator(server)}
                    </div>
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="font-display font-medium text-[13px] text-pure-black truncate">
                        {server.name}
                      </span>
                      <span className="font-mono text-[10px] text-silver truncate">
                        {server.command} {Array.isArray(server.args_json) && server.args_json.length > 0 ? server.args_json.join(' ') : ''}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
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

                    {/* Edit */}
                    <button
                      onClick={() => openEditDialog(server)}
                      className="p-1.5 rounded-interactive text-stone hover:text-pure-black hover:bg-light-gray/30 transition-colors"
                      title={t('mcp.edit')}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>

                    {/* Delete */}
                    <button
                      onClick={() => handleDelete(server.id)}
                      className="p-1.5 rounded-interactive text-stone hover:text-pure-black hover:bg-light-gray/30 transition-colors"
                      title={t('mcp.delete')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Info banner */}
      <section className="px-1">
        <div className="flex gap-3 p-3 rounded-container bg-snow border border-light-gray/20">
          <AlertCircle className="w-3.5 h-3.5 text-stone shrink-0 mt-0.5" />
          <p className="text-[11px] text-stone leading-relaxed">
            {t('mcp.description')}
          </p>
        </div>
      </section>

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
        formError={formError}
        onSave={handleSave}
        onClose={closeDialog}
      />
    </div>
  );
}