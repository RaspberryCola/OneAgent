import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// 导入英文翻译
import enCommon from '../locales/en/common.json';
import enLogin from '../locales/en/login.json';
import enSidebar from '../locales/en/sidebar.json';
import enSettings from '../locales/en/settings.json';
import enComposer from '../locales/en/composer.json';
import enSearch from '../locales/en/search.json';
import enChat from '../locales/en/chat.json';
import enWorkspace from '../locales/en/workspace.json';
import enTimeline from '../locales/en/timeline.json';

// 导入中文翻译
import zhCommon from '../locales/zh-CN/common.json';
import zhLogin from '../locales/zh-CN/login.json';
import zhSidebar from '../locales/zh-CN/sidebar.json';
import zhSettings from '../locales/zh-CN/settings.json';
import zhComposer from '../locales/zh-CN/composer.json';
import zhSearch from '../locales/zh-CN/search.json';
import zhChat from '../locales/zh-CN/chat.json';
import zhWorkspace from '../locales/zh-CN/workspace.json';
import zhTimeline from '../locales/zh-CN/timeline.json';

// 从 localStorage 读取用户语言偏好
const getStoredLanguage = (): string | undefined => {
  try {
    return localStorage.getItem('oneagent:language') || undefined;
  } catch {
    return undefined;
  }
};

// 保存用户语言偏好
export const setLanguagePreference = (lng: string): void => {
  try {
    localStorage.setItem('oneagent:language', lng);
  } catch {
    // Ignore storage errors
  }
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common: enCommon,
        login: enLogin,
        sidebar: enSidebar,
        settings: enSettings,
        composer: enComposer,
        search: enSearch,
        chat: enChat,
        workspace: enWorkspace,
        timeline: enTimeline,
      },
      zh: {
        common: zhCommon,
        login: zhLogin,
        sidebar: zhSidebar,
        settings: zhSettings,
        composer: zhComposer,
        search: zhSearch,
        chat: zhChat,
        workspace: zhWorkspace,
        timeline: zhTimeline,
      },
    },
    lng: getStoredLanguage(),
    fallbackLng: 'en',
    supportedLngs: ['en', 'zh'],
    interpolation: {
      escapeValue: false, // React already does escaping
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'oneagent:language',
      caches: [], // We handle storage manually
    },
    react: {
      useSuspense: false, // We don't want to use Suspense for translations
    },
  });

// 当语言改变时,保存到 localStorage
i18n.on('languageChanged', (lng) => {
  setLanguagePreference(lng);
});

export default i18n;
