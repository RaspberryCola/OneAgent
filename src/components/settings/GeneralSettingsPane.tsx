interface GeneralSettingsPaneProps {
  alwaysExpandThinking: boolean;
  onToggleAlwaysExpandThinking: () => void;
}

export function GeneralSettingsPane({
  alwaysExpandThinking,
  onToggleAlwaysExpandThinking,
}: GeneralSettingsPaneProps) {
  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="text-[10px] text-silver font-medium uppercase tracking-wider">Display</div>
        </div>

        <div className="border border-light-gray/60 rounded-container overflow-hidden bg-pure-white">
          <div className="flex items-center justify-between py-3 px-4">
            <div className="flex flex-col gap-0.5">
              <span className="font-display font-medium text-[13px] text-pure-black">
                Always Show Model Thinking Content
              </span>
              <span className="text-[11px] text-stone">
                When enabled, all thinking blocks are expanded by default, including completed conversations
              </span>
            </div>
            <button
              onClick={onToggleAlwaysExpandThinking}
              className={`relative w-12 h-7 rounded-full transition-colors border ${
                alwaysExpandThinking
                  ? 'bg-pure-black border-pure-black'
                  : 'bg-pure-white border-light-gray'
              }`}
            >
              <div
                className={`absolute top-[1px] w-6 h-6 rounded-full transition-transform ${
                  alwaysExpandThinking ? 'left-[22px] bg-pure-white' : 'left-[2px] bg-light-gray'
                }`}
              />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
