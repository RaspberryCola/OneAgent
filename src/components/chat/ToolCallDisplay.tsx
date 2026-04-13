import React, { useState } from 'react';
import { CollapsibleContent } from '../ui/CollapsibleContent';
import type { ToolCallProjection, TerminalRecord } from '../../lib/backend/types';

interface ToolCallDisplayProps {
  toolCall: ToolCallProjection;
  terminals: TerminalRecord[];
}

export function ToolCallDisplay({ toolCall, terminals }: ToolCallDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const status = toolCall.status.toLowerCase();
  const isRunning = status === "running" || status === "declared";

  return (
    <div className="flex w-full justify-start mt-0.5 mb-1">
      <div className="flex flex-col gap-1 min-w-0 w-full max-w-[95%] md:max-w-[85%] items-start">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 group cursor-pointer bg-transparent border-none p-0"
        >
          <span className="text-[12px] font-mono text-silver hover:text-stone transition-none">
            [{isRunning ? "running tool:" : "tool:"} {toolCall.title || toolCall.kind}]
          </span>
        </button>
        
        {isExpanded && (
          <div className="pl-2 border-l-2 border-light-gray/50 ml-1 w-full space-y-3">
            {toolCall.raw_input_json && (
              <div className="mt-1">
                <div className="text-[11px] font-mono text-silver mb-0.5">Input:</div>
                <CollapsibleContent maxHeight={150}>
                  <pre className="text-[12px] font-mono text-stone whitespace-pre-wrap break-words">
                    {JSON.stringify(toolCall.raw_input_json, null, 2)}
                  </pre>
                </CollapsibleContent>
              </div>
            )}
            
            {toolCall.raw_output_json && (
              <div className="mt-1">
                <div className="text-[11px] font-mono text-silver mb-0.5">Output:</div>
                <CollapsibleContent maxHeight={300}>
                  <pre className="text-[12px] font-mono text-stone whitespace-pre-wrap break-words">
                    {typeof toolCall.raw_output_json === 'string' 
                      ? toolCall.raw_output_json 
                      : JSON.stringify(toolCall.raw_output_json, null, 2)}
                  </pre>
                </CollapsibleContent>
              </div>
            )}

            {terminals.length > 0 && (
              <div className="space-y-2 mt-2">
                {terminals.map((terminal) => (
                  <div key={terminal.id}>
                    <div className="text-[12px] font-mono text-silver">
                      $ {terminal.command} {Array.isArray(terminal.args_json) ? terminal.args_json.join(" ") : ""}
                    </div>
                    {(terminal.stdout_buffer || terminal.stderr_buffer) && (
                      <CollapsibleContent maxHeight={400}>
                        <pre className="mt-1 text-[12px] font-mono whitespace-pre-wrap break-words text-stone">
                          {terminal.stdout_buffer || terminal.stderr_buffer}
                        </pre>
                      </CollapsibleContent>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
