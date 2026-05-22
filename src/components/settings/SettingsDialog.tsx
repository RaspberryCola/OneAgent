import { motion } from 'framer-motion';
import { Settings, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation("settings");
  
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
      className="fixed inset-0 bg-pure-black/10 z-[100] flex items-center justify-center p-0 md:p-4"
    >
      <div className="absolute inset-0" onClick={onClose} />
      <div
        className="w-full h-full md:max-w-4xl md:h-[640px] md:rounded-container bg-pure-white border border-light-gray z-10 flex flex-col overflow-hidden animate-in fade-in zoom-in duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
          <aside className="
            flex flex-row items-center w-full bg-snow flex-shrink-0 border-b border-light-gray/50 overflow-x-auto no-scrollbar p-2
            md:flex md:flex-col md:items-stretch md:w-[200px] md:bg-snow md:border-r md:border-light-gray/50 md:border-b-0 md:overflow-visible md:p-4
          ">
            {/* Title - desktop only */}
            <div className="hidden md:flex mb-4 px-2 font-display text-[14px] font-medium tracking-tight items-center gap-2">
              <Settings className="w-3.5 h-3.5" />
              <span>{t("title")}</span>
            </div>
            
            {/* Mobile close button */}
            <button
              onClick={onClose}
              className="md:hidden p-2.5 flex items-center justify-center shrink-0 text-stone hover:text-pure-black transition-colors"
              aria-label={t("close")}
            >
              <X className="w-4 h-4" />
            </button>
            
            {/* Navigation - horizontal on mobile, vertical on desktop */}
            <nav className="
              flex flex-row items-center space-y-0 space-x-1 flex-1
              md:flex md:flex-col md:items-stretch md:space-y-0.5 md:space-x-0 md:flex-1
            ">
              <button
                onClick={() => onSelectTab('general')}
                className={`
                  md:w-full md:text-left md:px-3 md:py-1.5 md:text-[12px]
                  whitespace-nowrap px-3 py-2 text-[12px] font-medium rounded-interactive transition-colors flex items-center
                  ${
                    settingsTab === 'general' ? 'bg-light-gray/60 text-pure-black' : 'text-stone hover:bg-light-gray/30'
                  }
                `}
              >
                {t("tabs.general")}
              </button>
              <button
                onClick={() => onSelectTab('agents')}
                className={`
                  md:w-full md:text-left md:px-3 md:py-1.5 md:text-[12px]
                  whitespace-nowrap px-3 py-2 text-[12px] font-medium rounded-interactive transition-colors flex items-center
                  ${
                    settingsTab === 'agents' ? 'bg-light-gray/60 text-pure-black' : 'text-stone hover:bg-light-gray/30'
                  }
                `}
              >
                {t("tabs.agents")}
              </button>
              <button
                onClick={() => onSelectTab('mcp')}
                className={`
                  md:w-full md:text-left md:px-3 md:py-1.5 md:text-[12px]
                  whitespace-nowrap px-3 py-2 text-[12px] rounded-interactive transition-colors flex items-center
                  ${
                    settingsTab === 'mcp' ? 'bg-light-gray/60 text-pure-black' : 'text-stone hover:bg-light-gray/30'
                  }
                `}
              >
                MCP
              </button>
              <button
                onClick={() => onSelectTab('im')}
                className={`
                  md:w-full md:text-left md:px-3 md:py-1.5 md:text-[12px]
                  whitespace-nowrap px-3 py-2 text-[12px] rounded-interactive transition-colors flex items-center
                  ${
                    settingsTab === 'im' ? 'bg-light-gray/60 text-pure-black' : 'text-stone hover:bg-light-gray/30'
                  }
                `}
              >
                {t("tabs.imChannels")}
              </button>
            </nav>
            
            {/* Close button - desktop only */}
            <div className="hidden md:block mt-4 pt-4 border-t border-light-gray/50">
              <button
                onClick={onClose}
                className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-interactive text-[12px] font-medium text-stone hover:bg-light-gray/30 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                <span>{t("close")}</span>
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
