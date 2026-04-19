import { useState } from 'react';
import { Loader2, CheckCircle2, Circle, ChevronDown, ChevronRight } from 'lucide-react';

type PlanMessageProps = {
  entries: Array<{ content?: string; text?: string; status?: string }>;
};

export function PlanMessage({ entries }: PlanMessageProps) {
  const [isCollapsed, setIsCollapsed] = useState(true);

  if (entries.length === 0) return null;

  const activeIndex = entries.findIndex(e => {
    const s = e.status?.toUpperCase() || 'PENDING';
    return s === 'IN_PROGRESS' || s === 'PROCESSING';
  });
  const firstPendingIndex = entries.findIndex(e => {
    const s = e.status?.toUpperCase() || 'PENDING';
    return s === 'PENDING';
  });
  const focusIndex = activeIndex !== -1 ? activeIndex : (firstPendingIndex !== -1 ? firstPendingIndex : entries.length - 1);
  const focusEntry = entries[focusIndex];

  const renderIcon = (statusStr: string) => {
    const isDone = statusStr === 'DONE' || statusStr === 'COMPLETED';
    const isInProgress = statusStr === 'IN_PROGRESS' || statusStr === 'PROCESSING';

    if (isInProgress) return <Loader2 className="w-3.5 h-3.5 text-pure-black animate-spin shrink-0 mt-[2px]" />;
    if (isDone) return <CheckCircle2 className="w-3.5 h-3.5 text-green shrink-0 mt-[2px]" />;
    return <Circle className="w-3.5 h-3.5 text-silver shrink-0 mt-[2px]" />;
  };

  const getStatus = (entry: any) => entry.status?.toUpperCase() || 'PENDING';
  const isEntryDone = (entry: any) => {
    const statusStr = getStatus(entry);
    return statusStr === 'DONE' || statusStr === 'COMPLETED';
  };

  const focusStatus = getStatus(focusEntry);

  return (
    <div 
      className="w-full border border-light-gray rounded-xl bg-snow p-[10px] flex flex-col shadow-sm cursor-pointer hover:bg-gray-50 transition-colors"
      onClick={() => setIsCollapsed(!isCollapsed)}
    >
      {!isCollapsed && (
        <div className="text-[10px] font-medium text-stone uppercase tracking-wider px-1 mb-1.5 flex justify-between items-center">
          <span>Plan</span>
          <ChevronDown className="w-3.5 h-3.5 text-stone" />
        </div>
      )}

      <div className="flex flex-col gap-1.5 w-full">
        {isCollapsed ? (
          <div className="flex items-start gap-2 px-1 w-full">
            {renderIcon(focusStatus)}
            <div className="min-w-0 flex-1 flex items-center justify-between gap-2 overflow-hidden">
              <div className={`text-[13px] leading-snug truncate w-full ${isEntryDone(focusEntry) ? 'text-stone line-through' : 'text-pure-black'}`}>
                {focusEntry.content || focusEntry.text || `Step ${focusIndex + 1}`}
              </div>
              <ChevronRight className="w-3.5 h-3.5 text-stone shrink-0 mt-[2px]" />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 w-full">
            {entries.map((entry, index) => {
              const statusStr = getStatus(entry);
              const isDone = isEntryDone(entry);
              return (
                <div 
                  key={index} 
                  className="flex items-start gap-2 px-1 w-full"
                >
                  {renderIcon(statusStr)}
                  <div className="min-w-0 flex-1">
                    <div className={`text-[13px] leading-snug whitespace-pre-wrap ${isDone ? 'text-stone line-through' : 'text-pure-black'}`}>
                      {entry.content || entry.text || `Step ${index + 1}`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
