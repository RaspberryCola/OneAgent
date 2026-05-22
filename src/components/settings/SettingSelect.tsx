import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown } from 'lucide-react';

interface SettingSelectProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  options: { value: string; label: string }[];
  label: string;
}

export function SettingSelect({
  value,
  onChange,
  placeholder,
  options,
  label,
}: SettingSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((o) => o.value === value);
  const displayText = selectedOption?.label || placeholder;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (val: string) => {
    onChange(val);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className="flex flex-col gap-1">
      <label className="text-[10px] font-medium text-stone uppercase tracking-wide">
        {label}
      </label>
      <div className="relative">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="w-full flex items-center justify-between gap-2 px-3 py-1.5 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors hover:bg-snow"
        >
          <span className={`truncate ${!value ? 'text-silver' : 'text-pure-black'}`}>
            {displayText}
          </span>
          <ChevronDown className={`w-3 h-3 text-stone shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>

        <AnimatePresence>
          {isOpen && (
            <>
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 4 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                className="absolute top-full left-0 mt-1 w-full max-h-[250px] overflow-y-auto bg-pure-white border border-light-gray rounded-container z-50 py-1.5 flex flex-col scrollbar-thin"
              >
                {options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => handleSelect(option.value)}
                    className={`w-full text-left px-3 py-2 text-[12px] transition-colors ${
                      option.value === value
                        ? 'bg-light-gray/60 text-pure-black font-medium'
                        : 'text-near-black hover:bg-snow'
                    } ${!option.value ? 'text-silver' : ''}`}
                  >
                    {option.label}
                  </button>
                ))}
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
