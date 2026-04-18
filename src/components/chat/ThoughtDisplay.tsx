import React, { useState, useEffect } from 'react';
import { useAppStore } from '../../lib/store';

interface ThoughtDisplayProps {
  content: string;
  status: "thinking" | "done";
  duration_ms?: number | null;
}

export function ThoughtDisplay({ content, status, duration_ms }: ThoughtDisplayProps) {
  const alwaysExpandThinking = useAppStore((state) => state.alwaysExpandThinking);
  const [isExpanded, setIsExpanded] = useState(alwaysExpandThinking || status === "thinking");
  const [elapsed, setElapsed] = useState<number>(0);

  // Update expanded state when setting changes
  useEffect(() => {
    if (alwaysExpandThinking) {
      setIsExpanded(true);
    } else if (status !== "thinking") {
      // Only collapse done thoughts when setting is off
      // Keep thinking thoughts expanded
      setIsExpanded(false);
    }
  }, [alwaysExpandThinking, status]);

  useEffect(() => {
    if (status === "thinking") {
      setIsExpanded(true);
      const start = Date.now();
      const timer = setInterval(() => {
        setElapsed(Date.now() - start);
      }, 100);
      return () => clearInterval(timer);
    } else {
      setElapsed(duration_ms || 0);
    }
  }, [status, duration_ms]);

  const displayTime = status === "thinking"
    ? (elapsed / 1000).toFixed(1)
    : duration_ms ? (duration_ms / 1000).toFixed(1) : null;

  return (
    <div className="flex w-full justify-start mt-0.5 mb-1">
      <div className="flex flex-col gap-1 min-w-0 w-full max-w-[95%] md:max-w-[85%] items-start">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 group cursor-pointer bg-transparent border-none p-0"
        >
          <span className="text-[12px] font-mono text-silver hover:text-stone transition-none">
            {status === "thinking" ? "[thinking...]" : "[thought]"}
            {displayTime && ` ${displayTime}s`}
          </span>
        </button>

        {isExpanded && (
          <div className="text-[13px] text-stone leading-relaxed whitespace-pre-wrap pl-2 border-l-2 border-light-gray/50 ml-1">
            {content || "..."}
          </div>
        )}
      </div>
    </div>
  );
}