import { AlertCircle } from 'lucide-react';

export function McpSettingsPane() {
  return (
    <div className="space-y-6">
      <section>
        <div className="flex gap-3 p-3 rounded-container bg-snow border border-light-gray/20">
          <AlertCircle className="w-3.5 h-3.5 text-stone shrink-0 mt-0.5" />
          <p className="text-[11px] text-stone leading-relaxed">
            MCP server configuration will be available in a future update.
          </p>
        </div>
      </section>
    </div>
  );
}
