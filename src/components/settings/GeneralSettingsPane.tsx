import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { setLanguagePreference } from "../../i18n";

interface GeneralSettingsPaneProps {
  alwaysExpandThinking: boolean;
  onToggleAlwaysExpandThinking: () => void;
  showAgentIconInList: boolean;
  onToggleShowAgentIconInList: () => void;
}

const LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
];

export function GeneralSettingsPane({
  alwaysExpandThinking,
  onToggleAlwaysExpandThinking,
  showAgentIconInList,
  onToggleShowAgentIconInList,
}: GeneralSettingsPaneProps) {
  const { t, i18n: i18nInstance } = useTranslation("settings");
  const [langDropdownOpen, setLangDropdownOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; right: number } | null>(null);
  const langRef = useRef<HTMLDivElement>(null);

  const handleLanguageChange = (lang: string) => {
    i18nInstance.changeLanguage(lang);
    setLanguagePreference(lang);
    setLangDropdownOpen(false);
  };

  const currentLanguage = i18nInstance.language;
  const selectedLang = LANGUAGE_OPTIONS.find((o) => o.value === currentLanguage);
  const displayLang = selectedLang?.label || "English";

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(e.target as Node)) {
        setLangDropdownOpen(false);
        setDropdownPosition(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleToggleDropdown = () => {
    if (!langDropdownOpen && langRef.current) {
      const rect = langRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    } else {
      setDropdownPosition(null);
    }
    setLangDropdownOpen(!langDropdownOpen);
  };

  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="text-[10px] text-silver font-medium uppercase tracking-wider">{t("language.title")}</div>
        </div>

        <div className="border border-light-gray/60 rounded-container overflow-hidden bg-pure-white">
          <div className="flex items-center justify-between py-3 px-4">
            <div className="flex flex-col gap-0.5">
              <span className="font-display font-medium text-[13px] text-pure-black">
                {t("language.description")}
              </span>
            </div>
            <div ref={langRef}>
              <button
                type="button"
                onClick={handleToggleDropdown}
                className="flex items-center justify-between gap-2 w-32 px-3 py-1.5 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors hover:bg-snow"
              >
                <span className="truncate">{displayLang}</span>
                <ChevronDown className={`w-3 h-3 text-stone shrink-0 transition-transform ${langDropdownOpen ? 'rotate-180' : ''}`} />
              </button>
            </div>
          </div>
        </div>

        <AnimatePresence>
          {langDropdownOpen && dropdownPosition && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 4 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="fixed w-32 overflow-y-auto bg-pure-white border border-light-gray rounded-container z-[150] py-1.5 flex flex-col scrollbar-thin shadow-lg"
              style={{
                top: dropdownPosition.top,
                right: dropdownPosition.right,
              }}
            >
              {LANGUAGE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleLanguageChange(option.value)}
                  className={`w-full text-left px-3 py-2 text-[12px] transition-colors ${
                    option.value === currentLanguage
                      ? 'bg-light-gray/60 text-pure-black font-medium'
                      : 'text-near-black hover:bg-snow'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="text-[10px] text-silver font-medium uppercase tracking-wider">{t("display")}</div>
        </div>

        <div className="border border-light-gray/60 rounded-container overflow-hidden bg-pure-white">
          <div className="flex items-center justify-between py-3 px-4">
            <div className="flex flex-col gap-0.5">
              <span className="font-display font-medium text-[13px] text-pure-black">
                {t("alwaysShowThinking")}
              </span>
              <span className="text-[11px] text-stone">
                {t("alwaysShowThinkingDesc")}
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
          <div className="flex items-center justify-between py-3 px-4 border-t border-light-gray/60">
            <div className="flex flex-col gap-0.5">
              <span className="font-display font-medium text-[13px] text-pure-black">
                {t("showAgentIcons")}
              </span>
              <span className="text-[11px] text-stone">
                {t("showAgentIconsDesc")}
              </span>
            </div>
            <button
              onClick={onToggleShowAgentIconInList}
              className={`relative w-12 h-7 rounded-full transition-colors border ${
                showAgentIconInList
                  ? 'bg-pure-black border-pure-black'
                  : 'bg-pure-white border-light-gray'
              }`}
            >
              <div
                className={`absolute top-[1px] w-6 h-6 rounded-full transition-transform ${
                  showAgentIconInList ? 'left-[22px] bg-pure-white' : 'left-[2px] bg-light-gray'
                }`}
              />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
