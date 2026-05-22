import { useTranslation } from "react-i18next";
import { setLanguagePreference } from "../../i18n";

interface GeneralSettingsPaneProps {
  alwaysExpandThinking: boolean;
  onToggleAlwaysExpandThinking: () => void;
}

export function GeneralSettingsPane({
  alwaysExpandThinking,
  onToggleAlwaysExpandThinking,
}: GeneralSettingsPaneProps) {
  const { t, i18n: i18nInstance } = useTranslation("settings");

  const handleLanguageChange = (lang: string) => {
    i18nInstance.changeLanguage(lang);
    setLanguagePreference(lang);
  };

  const currentLanguage = i18nInstance.language;

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
            <div className="flex gap-2">
              <button
                onClick={() => handleLanguageChange("en")}
                className={`px-4 py-1.5 rounded-interactive text-[12px] font-medium transition-colors ${
                  currentLanguage === "en"
                    ? "bg-pure-black text-pure-white"
                    : "bg-snow text-stone hover:bg-light-gray/30 border border-light-gray"
                }`}
              >
                {t("language.english")}
              </button>
              <button
                onClick={() => handleLanguageChange("zh")}
                className={`px-4 py-1.5 rounded-interactive text-[12px] font-medium transition-colors ${
                  currentLanguage === "zh"
                    ? "bg-pure-black text-pure-white"
                    : "bg-snow text-stone hover:bg-light-gray/30 border border-light-gray"
                }`}
              >
                {t("language.chinese")}
              </button>
            </div>
          </div>
        </div>
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
        </div>
      </section>
    </div>
  );
}
