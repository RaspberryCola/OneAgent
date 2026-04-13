import React from 'react';
import { CollapsibleContent } from '../ui/CollapsibleContent';
import type { TerminalRecord } from '../../lib/backend/types';

interface TerminalDisplayProps {
  content: string;
  stream: string;
  event: string;
  terminal: TerminalRecord | null;
}

export function TerminalDisplay({ content, stream, event, terminal }: TerminalDisplayProps) {
  return (
    <div className="flex w-full justify-start mt-0.5 mb-1">
      <div className="flex flex-col gap-1 min-w-0 w-full max-w-[95%] md:max-w-[85%] items-start">
        <div className="text-[12px] font-mono text-silver">
          [terminal: {terminal?.command || "sh"}] {event}
        </div>
        <div className="pl-2 border-l-2 border-light-gray/50 ml-1 w-full">
          <CollapsibleContent maxHeight={300}>
            <pre className="text-[12px] font-mono whitespace-pre-wrap break-words text-stone mt-1">
              {content || "..."}
            </pre>
          </CollapsibleContent>
        </div>
      </div>
    </div>
  );
}
