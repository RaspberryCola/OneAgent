import { motion } from 'framer-motion';
import { Settings, X } from 'lucide-react';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import type * as Types from '../../lib/backend/types';
import { AgentSettingsPane } from './AgentSettingsPane';
import { GeneralSettingsPane } from './GeneralSettingsPane';
import { McpSettingsPane } from './McpSettingsPane';
import { ImSettingsPane } from './ImSettingsPane';

type SettingsTab = 'general' | 'agents' | 'mcp' | 'im';

interface SettingsDialogProps {
  isOpen: boolean;
  settingsTab: SettingsTab;
  alwaysExpandThinking: boolean;
  sortedDiscoveryStatus: Types.AgentDiscoveryStatus[];
  availableAgentsCount: number;
  onClose: () => void;
  onSelectTab: (tab: SettingsTab) => void;
  onToggleAlwaysExpandThinking: () => void;
  renderAgentLogo: (agent: Types.AgentDiscoveryStatus, className: string) => ReactNode;
  webuiEnabled: boolean;
  webuiPassword: string | null;
  webuiInfo: { port: number; urls: string[] } | null;
  onToggleWebuiEnabled: () => Promise<string | null>;
}

export function SettingsDialog({
  isOpen,
  settingsTab,
  alwaysExpandThinking,
  sortedDiscoveryStatus,
  availableAgentsCount,
  onClose,
  onSelectTab,
  onToggleAlwaysExpandThinking,
  renderAgentLogo,
  webuiEnabled,
  webuiPassword,
  webuiInfo,
  onToggleWebuiEnabled,
}: SettingsDialogProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-pure-black/10 z-[100] flex items-center justify-center p-4"
    >
      <div className="absolute inset-0" onClick={onClose} />
      <div
        className="w-full max-w-4xl h-[640px] bg-pure-white rounded-container border border-light-gray z-10 flex flex-col overflow-hidden animate-in fade-in zoom-in duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-1 flex overflow-hidden">
          <aside className="w-[200px] bg-snow flex flex-col p-4 border-r border-light-gray/50">
            <div className="mb-4 px-2 font-display text-[14px] font-medium tracking-tight flex items-center gap-2">
              <Settings className="w-3.5 h-3.5" />
              <span>Settings</span>
            </div>
            <nav className="space-y-0.5 flex-1">
              <button
                onClick={() => onSelectTab('general')}
                className={`w-full text-left px-3 py-1.5 rounded-interactive text-[12px] font-medium transition-colors ${
                  settingsTab === 'general' ? 'bg-light-gray/60 text-pure-black' : 'text-stone hover:bg-light-gray/30'
                }`}
              >
                General
              </button>
              <button
                onClick={() => onSelectTab('agents')}
                className={`w-full text-left px-3 py-1.5 rounded-interactive text-[12px] font-medium transition-colors ${
                  settingsTab === 'agents' ? 'bg-light-gray/60 text-pure-black' : 'text-stone hover:bg-light-gray/30'
                }`}
              >
                Agents
              </button>
              <button
                onClick={() => onSelectTab('mcp')}
                className={`w-full text-left px-3 py-1.5 rounded-interactive text-[12px] transition-colors ${
                  settingsTab === 'mcp' ? 'bg-light-gray/60 text-pure-black' : 'text-stone hover:bg-light-gray/30'
                }`}
              >
                MCP
              </button>
              <button
                onClick={() => onSelectTab('im')}
                className={`w-full text-left px-3 py-1.5 rounded-interactive text-[12px] transition-colors ${
                  settingsTab === 'im' ? 'bg-light-gray/60 text-pure-black' : 'text-stone hover:bg-light-gray/30'
                }`}
              >
                IM Channels
              </button>
            </nav>
            <div className="mt-4 pt-4 border-t border-light-gray/50">
              <button
                onClick={onClose}
                className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-interactive text-[12px] font-medium text-stone hover:bg-light-gray/30 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                <span>Close</span>
              </button>
            </div>
          </aside>

          <div className="flex-1 flex flex-col min-w-0 bg-pure-white relative">
            {settingsTab === 'im' ? (
              <div className="flex-1 overflow-hidden p-6">
                <ImSettingsPane
                  webuiEnabled={webuiEnabled}
                  webuiPassword={webuiPassword}
                  webuiInfo={webuiInfo}
                  onToggleWebuiEnabled={onToggleWebuiEnabled}
                />
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-6">
                {settingsTab === 'general' && (
                  <GeneralSettingsPane
                    alwaysExpandThinking={alwaysExpandThinking}
                    onToggleAlwaysExpandThinking={onToggleAlwaysExpandThinking}
                  />
                )}
                {settingsTab === 'agents' && (
                  <AgentSettingsPane
                    sortedDiscoveryStatus={sortedDiscoveryStatus}
                    availableAgentsCount={availableAgentsCount}
                    renderAgentLogo={renderAgentLogo}
                  />
                )}
                {settingsTab === 'mcp' && <McpSettingsPane />}
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
