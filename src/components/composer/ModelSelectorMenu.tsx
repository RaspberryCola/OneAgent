import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Eye, Loader2 } from 'lucide-react';
import type { ModelSelectorState } from '../../hooks';

interface ModelSelectorMenuProps {
  modelSelector: ModelSelectorState | null;
  selectedModelValue: any;
  selectedModelLabel: string | null;
  onModelChange: (value: any) => void;
  isSettingModel: boolean;
  isCompact: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

export function ModelSelectorMenu({
  modelSelector,
  selectedModelValue,
  selectedModelLabel,
  onModelChange,
  isSettingModel,
  isCompact,
  isOpen,
  setIsOpen,
}: ModelSelectorMenuProps) {
  const selectedChoice = modelSelector?.choices.find((choice) => String(choice.value) === String(selectedModelValue));

  if (!modelSelector) {
    return (
      <span
        title="Model info not available"
        className={`flex items-center ${isCompact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-small'} text-stone bg-transparent rounded-pill select-none`}
      >
        <span className="truncate max-w-[120px] font-medium">Default Model</span>
      </span>
    );
  }

  if (modelSelector.choices.length === 0) {
    return (
      <span
        title="Model switching not available"
        className={`flex items-center ${isCompact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-small'} text-stone bg-transparent rounded-pill select-none`}
      >
        <span className="truncate max-w-[150px] font-medium">
          {selectedModelLabel || 'Default Model'}
        </span>
      </span>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => !isSettingModel && setIsOpen(!isOpen)}
        disabled={isSettingModel}
        className={`flex items-center gap-1.25 ${isCompact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-small'} text-stone bg-transparent rounded-pill transition-colors select-none ${
          !isSettingModel ? 'hover:text-pure-black hover:bg-snow' : 'opacity-60 cursor-not-allowed'
        }`}
      >
        {isSettingModel && <Loader2 className={isCompact ? 'w-3 h-3 animate-spin' : 'w-3.5 h-3.5 animate-spin'} />}
        <span className="truncate max-w-[150px] font-medium">
          {selectedChoice?.label || selectedModelLabel || 'Select Model'}
        </span>
        {selectedChoice?.supportsVision === true && (
          <span title="Supports vision input">
            <Eye className={`${isCompact ? 'w-2.5 h-2.5' : 'w-3 h-3'} text-stone`} />
          </span>
        )}
        <ChevronDown className={`${isCompact ? 'w-2.5 h-2.5' : 'w-3 h-3'} transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <>
            <div className="fixed inset-0 z-[60]" onClick={() => setIsOpen(false)} />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 5 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 5 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="absolute bottom-full left-0 mb-2 w-max min-w-[220px] max-w-[320px] max-h-[300px] overflow-y-auto bg-pure-white border border-light-gray rounded-container z-[70] py-1.5 flex flex-col scrollbar-thin shadow-none"
            >
              <div className="px-3 py-1">
                <span className="text-[10px] font-medium text-silver tracking-wider">Models</span>
              </div>
              {modelSelector.choices.map((choice) => (
                <button
                  key={String(choice.value)}
                  type="button"
                  onClick={() => {
                    onModelChange(choice.value);
                    setIsOpen(false);
                  }}
                  title={choice.label}
                  className={`w-full text-left px-3 py-2 text-[13px] transition-colors flex items-center justify-between gap-4 ${
                    String(choice.value) === String(selectedModelValue)
                      ? 'bg-light-gray/60 text-pure-black font-medium'
                      : 'text-near-black hover:bg-snow'
                  }`}
                >
                  <span className="truncate">{choice.label}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    {choice.supportsVision === true && (
                      <span title="Supports vision input">
                        <Eye className="w-3.5 h-3.5 text-stone" />
                      </span>
                    )}
                    {String(choice.value) === String(selectedModelValue) && (
                      <Check className="w-3.5 h-3.5 text-pure-black shrink-0" />
                    )}
                  </div>
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
