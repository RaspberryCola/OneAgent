import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import type * as Types from '../../lib/backend/types';

interface ModeSelectorMenuProps {
  activeModeState?: Types.AcpSessionModeState | null;
  selectedModeValue?: any;
  selectedModeLabel?: string | null;
  onModeChange?: (value: any) => void;
  isSettingMode?: boolean;
  isCompact: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

export function ModeSelectorMenu({
  activeModeState,
  selectedModeValue,
  selectedModeLabel,
  onModeChange,
  isSettingMode,
  isCompact,
  isOpen,
  setIsOpen,
}: ModeSelectorMenuProps) {
  if (!activeModeState || !activeModeState.available_modes?.length || !onModeChange) {
    return null;
  }

  const modeChoices = activeModeState.available_modes;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => !isSettingMode && setIsOpen(!isOpen)}
        disabled={isSettingMode}
        className={`flex items-center gap-1.25 ${isCompact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-small'} text-stone bg-transparent rounded-interactive transition-colors select-none ${
          !isSettingMode ? 'hover:text-pure-black hover:bg-snow' : 'opacity-60 cursor-not-allowed'
        }`}
      >
        {isSettingMode && <Loader2 className={isCompact ? 'w-3 h-3 animate-spin' : 'w-3.5 h-3.5 animate-spin'} />}
        <span className="truncate max-w-[150px] font-medium">
          {selectedModeLabel ?? selectedModeValue ?? 'Select Mode'}
        </span>
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
                <span className="text-[10px] font-medium text-silver tracking-wider">Modes</span>
              </div>
              {modeChoices.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  onClick={() => {
                    onModeChange(choice.id);
                    setIsOpen(false);
                  }}
                  title={choice.description ?? choice.name}
                  className={`w-full text-left px-3 py-2 text-[13px] transition-colors flex items-center justify-between gap-4 ${
                    String(choice.id) === String(selectedModeValue)
                      ? 'bg-light-gray/60 text-pure-black font-medium'
                      : 'text-near-black hover:bg-snow'
                  }`}
                >
                  <span className="truncate">{choice.name?.trim() || choice.id?.trim() || 'Mode'}</span>
                  {String(choice.id) === String(selectedModeValue) && (
                    <Check className="w-3.5 h-3.5 text-pure-black shrink-0" />
                  )}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
