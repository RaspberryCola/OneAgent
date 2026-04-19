type PlanMessageProps = {
  entries: Array<{ content?: string; text?: string; status?: string }>;
};

export function PlanMessage({ entries }: PlanMessageProps) {
  return (
    <div className="flex w-full justify-start mt-1 mb-2">
      <div className="w-full max-w-[95%] md:max-w-[85%] border border-light-gray rounded-container bg-snow px-4 py-3">
        <div className="text-[11px] font-medium text-stone uppercase tracking-wider mb-2">Plan</div>
        <div className="space-y-2">
          {entries.length === 0 && <div className="text-[13px] text-stone">No plan details yet.</div>}
          {entries.map((entry, index) => (
            <div key={index} className="flex items-start gap-3">
              <div className="mt-1 w-1.5 h-1.5 rounded-full bg-stone shrink-0" />
              <div className="min-w-0">
                <div className="text-[14px] leading-relaxed text-pure-black whitespace-pre-wrap">
                  {entry.content || entry.text || `Step ${index + 1}`}
                </div>
                {entry.status && <div className="text-[11px] text-silver uppercase tracking-wider mt-1">{entry.status}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
