import { useTranslation } from 'react-i18next';
import type * as Types from '../../lib/backend/types';
import { SettingSelect } from './SettingSelect';
import { SettingSelectWithSearch } from './SettingSelectWithSearch';

interface ChannelSessionRoutingProps {
  workspaceId: string;
  agentProfileId: string;
  modelId: string;
  availableModels: Types.AcpAvailableModel[];
  workspaces: Types.Workspace[];
  agents: Types.AgentProfile[];
  onUpdateConfig: (wsId: string, agentId: string, modelId: string) => void | Promise<void>;
}

export function ChannelSessionRouting({
  workspaceId,
  agentProfileId,
  modelId,
  availableModels,
  workspaces,
  agents,
  onUpdateConfig,
}: ChannelSessionRoutingProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="border border-light-gray/60 rounded-container p-4 bg-pure-white space-y-4">
      <span className="font-display font-medium text-[13px] text-pure-black">
        {t('sessionRouting.title')}
      </span>
      <div className="grid grid-cols-3 gap-4">
        <SettingSelect
          value={workspaceId}
          onChange={(v) => onUpdateConfig(v, agentProfileId, modelId)}
          placeholder="Default Workspace (First Available)"
          label={t('sessionRouting.workspace')}
          options={[
            { value: '', label: 'Default Workspace (First Available)' },
            ...workspaces.map((ws) => ({ value: ws.id, label: ws.display_name || ws.cwd })),
          ]}
        />
        <SettingSelect
          value={agentProfileId}
          onChange={(v) => onUpdateConfig(workspaceId, v, modelId)}
          placeholder="Default Agent (First Enabled)"
          label="Agent"
          options={[
            { value: '', label: 'Default Agent (First Enabled)' },
            ...agents.map((a) => ({ value: a.id, label: a.name })),
          ]}
        />
        <SettingSelectWithSearch
          value={modelId}
          onChange={(v) => onUpdateConfig(workspaceId, agentProfileId, v)}
          placeholder="Default Model (Agent Default)"
          label="Model"
          searchPlaceholder="Search models..."
          options={[
            { value: '', label: 'Default Model (Agent Default)' },
            ...availableModels.map((m) => ({ value: m.id ?? m.model_id ?? '', label: m.name ?? m.id ?? '' })),
          ]}
        />
      </div>
    </div>
  );
}
