import { Wrench, FileText, MessageSquare, RefreshCw } from 'lucide-react';
import type * as Types from '../../lib/backend/types';

type DetailTab = 'tools' | 'resources' | 'prompts';

interface McpDetailPanelProps {
  server: Types.McpServerConfig;
  status: Types.McpServerStatus;
  detailTab: DetailTab;
  onSetDetailTab: (tab: DetailTab) => void;
  t: (key: string) => string;
}

export function McpDetailPanel({
  server,
  status,
  detailTab,
  onSetDetailTab,
  t,
}: McpDetailPanelProps) {
  const realTools = status.tools.filter((t) => t.name);
  const realResources = status.resources || [];
  const realPrompts = status.prompts || [];

  const tabs: { key: DetailTab; label: string; count: number; icon: typeof Wrench }[] = [
    { key: 'tools', label: t('mcp.tools'), count: realTools.length, icon: Wrench },
    { key: 'resources', label: t('mcp.resources'), count: realResources.length, icon: FileText },
    { key: 'prompts', label: t('mcp.prompts'), count: realPrompts.length, icon: MessageSquare },
  ];

  const visibleTabs = tabs.filter((tab) => tab.count > 0 || tab.key === 'tools');
  const showTabBar = visibleTabs.length > 1;

  return (
    <div className="border-t border-light-gray/30 bg-snow/60">
      {/* Tab bar */}
      {showTabBar && (
        <div className="flex items-center gap-0.5 px-4 pt-2">
          {visibleTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => onSetDetailTab(tab.key)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-medium transition-colors ${
                detailTab === tab.key
                  ? 'bg-pure-black text-pure-white'
                  : 'text-stone hover:text-pure-black hover:bg-light-gray/40'
              }`}
            >
              <tab.icon className="w-3 h-3" />
              {tab.label}
              {tab.count > 0 && (
                <span className={`text-[9px] px-1 rounded-full ${
                  detailTab === tab.key ? 'bg-pure-white/20' : 'bg-light-gray/60'
                }`}>{tab.count}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Tab content */}
      <div className={`px-4 pb-3 max-h-80 overflow-y-auto ${showTabBar ? 'pt-3' : 'pt-4'}`}>
        {detailTab === 'tools' && (
          realTools.length > 0 ? (
            <div className="space-y-1.5">
              {realTools.map((tool, idx) => (
                <div key={idx} className="px-3 py-2 rounded-interactive bg-pure-white border border-light-gray/20">
                  <div className="flex items-start justify-between gap-2">
                    <code className="font-mono text-[11px] font-medium text-pure-black shrink-0">{tool.name}</code>
                    {tool.input_schema?.properties && Object.keys(tool.input_schema.properties).length > 0 && (
                      <div className="flex flex-wrap gap-1 justify-end">
                        {Object.entries(tool.input_schema.properties).map(([key, prop]: [string, any]) => (
                          <span key={key} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-light-gray/30 text-[9px] font-mono text-stone">
                            {key}
                            {tool.input_schema.required?.includes(key) && <span className="text-rose-500">*</span>}
                            {prop.type && <span className="text-silver">:{prop.type}</span>}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] text-stone leading-relaxed mt-0.5" title={tool.description || undefined}>
                    {tool.description || t('mcp.noDescription')}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-silver py-2 text-center">{t('mcp.noToolsDiscovered')}</div>
          )
        )}
        {detailTab === 'resources' && (
          realResources.length > 0 ? (
            <div className="space-y-1.5">
              {realResources.map((res, idx) => (
                <div key={idx} className="px-3 py-2 rounded-interactive bg-pure-white border border-light-gray/20">
                  <code className="font-mono text-[11px] font-medium text-pure-black">{res.name}</code>
                  <p className="text-[10px] text-stone leading-relaxed mt-0.5" title={res.description || undefined}>
                    {res.description || res.uri || t('mcp.noDescription')}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-silver py-2 text-center">No resources</div>
          )
        )}
        {detailTab === 'prompts' && (
          realPrompts.length > 0 ? (
            <div className="space-y-1.5">
              {realPrompts.map((prompt, idx) => (
                <div key={idx} className="px-3 py-2 rounded-interactive bg-pure-white border border-light-gray/20">
                  <code className="font-mono text-[11px] font-medium text-pure-black">{prompt.name}</code>
                  <p className="text-[10px] text-stone leading-relaxed mt-0.5" title={prompt.description || undefined}>
                    {prompt.description || t('mcp.noDescription')}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-silver py-2 text-center">No prompts</div>
          )
        )}
      </div>
    </div>
  );
}
