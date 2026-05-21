import { AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import type * as Types from '../../lib/backend/types';

interface AgentSettingsPaneProps {
  sortedDiscoveryStatus: Types.AgentDiscoveryStatus[];
  availableAgentsCount: number;
  renderAgentLogo: (agent: Types.AgentDiscoveryStatus, className: string) => ReactNode;
}

export function AgentSettingsPane({
  sortedDiscoveryStatus,
  availableAgentsCount,
  renderAgentLogo,
}: AgentSettingsPaneProps) {
  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="text-[10px] text-silver font-medium uppercase tracking-wider">Agents</div>
        </div>

        <div className="border border-light-gray/60 rounded-container overflow-hidden bg-pure-white">
          {sortedDiscoveryStatus.map((agent, index) => (
            <div
              key={agent.command}
              className={`group relative flex items-center justify-between py-3 px-4 transition-colors hover:bg-snow ${
                index !== sortedDiscoveryStatus.length - 1 ? 'border-b border-light-gray/30' : ''
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-interactive flex items-center justify-center border border-light-gray/50 transition-colors p-1.5 ${
                  agent.availability !== 'unavailable' ? 'bg-pure-white' : 'bg-snow opacity-50'
                }`}>
                  {renderAgentLogo(agent, 'w-full h-full object-contain')}
                </div>
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="font-display font-medium text-[13px] text-pure-black leading-tight shrink-0">
                    {agent.name}
                  </span>
                  <span className="font-mono text-[10px] text-silver truncate">{agent.command}</span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <span className={`flex items-center gap-1 px-2 py-0.5 rounded-interactive text-[9px] font-medium uppercase tracking-wide ${
                  agent.availability === 'ready'
                    ? 'bg-light-gray/40 text-near-black'
                    : agent.availability === 'degraded'
                      ? 'border border-light-gray/40 text-stone'
                      : 'border border-light-gray/40 text-silver'
                }`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${
                    agent.availability === 'ready'
                      ? 'bg-[#10b981]'
                      : agent.availability === 'degraded'
                        ? 'bg-[#f59e0b]'
                        : 'bg-[#9ca3af]'
                  }`} />
                  {agent.availability}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="px-1 space-y-2">
        {sortedDiscoveryStatus
          .filter((agent) => agent.detail && agent.availability !== 'degraded')
          .map((agent) => (
            <div key={`${agent.command}-detail`} className="flex gap-3 p-3 rounded-container bg-snow border border-light-gray/20">
              <AlertCircle className="w-3.5 h-3.5 text-stone shrink-0 mt-0.5" />
              <p className="text-[11px] text-stone leading-relaxed">
                <span className="font-medium text-pure-black">{agent.name}:</span> {agent.detail}
              </p>
            </div>
          ))}
      </section>

      {availableAgentsCount > 0 && (
        <section className="px-1">
          <div className="flex gap-3 p-3 rounded-container bg-snow border border-light-gray/20">
            <AlertCircle className="w-3.5 h-3.5 text-stone shrink-0 mt-0.5" />
            <p className="text-[11px] text-stone leading-relaxed">
              Native ACP agents are detected from your system <code className="text-pure-black font-medium">PATH</code>. Claude Code is exposed through a bundled or system bridge runtime.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
