import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Square } from 'lucide-react';
import { useAppStore } from '../../lib/store';
import type { BrowserSessionConfig, BrowserState } from '../../lib/backend/types';

interface BrowserSettingsPaneProps {
  workspaceId: string;
}

const STATUS_CONFIG: Record<BrowserState, { dot: string; color: string }> = {
  stopped: { dot: 'bg-[#9ca3af]', color: 'text-stone' },
  starting: { dot: 'bg-[#f59e0b]', color: 'text-stone' },
  running: { dot: 'bg-[#10b981]', color: 'text-pure-black' },
  error: { dot: 'bg-[#ef4444]', color: 'text-[#ef4444]' },
};

export function BrowserSettingsPane({ workspaceId }: BrowserSettingsPaneProps) {
  const { t } = useTranslation('settings');
  const {
    browserStatus,
    browserConfig,
    loadBrowserConfig,
    saveBrowserConfig,
    startBrowser,
    stopBrowser,
  } = useAppStore();

  const [localConfig, setLocalConfig] = useState<BrowserSessionConfig>({
    enabled: false,
    headless: true,
    viewport_width: 1280,
    viewport_height: 720,
    enable_screenshots: false,
    screenshot_interval_ms: 5000,
  });

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    loadBrowserConfig(workspaceId);
  }, [workspaceId, loadBrowserConfig]);

  useEffect(() => {
    if (browserConfig) {
      setLocalConfig(browserConfig);
    }
  }, [browserConfig]);

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await saveBrowserConfig(workspaceId, localConfig);
    } catch (error) {
      setSaveError(String(error));
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleBrowser = async () => {
    if (browserStatus.state === 'running' || browserStatus.state === 'starting') {
      await stopBrowser();
    } else {
      await startBrowser(localConfig);
    }
  };

  const updateConfig = (updates: Partial<BrowserSessionConfig>) => {
    setLocalConfig(prev => ({ ...prev, ...updates }));
  };

  const { dot, color } = STATUS_CONFIG[browserStatus.state];
  const isRunning = browserStatus.state === 'running' || browserStatus.state === 'starting';

  return (
    <div className="space-y-6">
      {/* Status Section */}
      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="text-[10px] text-silver font-medium uppercase tracking-wider">
            {t('browser.status')}
          </div>
        </div>
        <div className="border border-light-gray/60 rounded-container overflow-hidden bg-pure-white">
          {/* Status row */}
          <div className="flex items-center justify-between py-3 px-4">
            <div className="font-display font-medium text-[13px] text-pure-black">
              {t('browser.status')}
            </div>
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${dot} ${browserStatus.state === 'starting' ? 'animate-pulse' : ''}`} />
              <span className={`text-[12px] font-medium ${color}`}>
                {t(`browser.${browserStatus.state}`)}
              </span>
            </div>
          </div>

          {/* Current URL row */}
          {browserStatus.current_url && (
            <>
              <div className="border-t border-light-gray/30" />
              <div className="flex items-center justify-between py-3 px-4">
                <div className="font-display font-medium text-[13px] text-pure-black">
                  {t('browser.currentUrl')}
                </div>
                <div className="text-[12px] text-stone truncate max-w-[240px]">
                  {browserStatus.current_url}
                </div>
              </div>
            </>
          )}

          {/* CDP Port row */}
          {browserStatus.cdp_port && (
            <>
              <div className="border-t border-light-gray/30" />
              <div className="flex items-center justify-between py-3 px-4">
                <div className="font-display font-medium text-[13px] text-pure-black">
                  {t('browser.cdpPort')}
                </div>
                <div className="text-[12px] text-stone">
                  {browserStatus.cdp_port}
                </div>
              </div>
            </>
          )}

          {/* Error row */}
          {browserStatus.error && (
            <>
              <div className="border-t border-light-gray/30" />
              <div className="flex items-center justify-between py-3 px-4">
                <div className="font-display font-medium text-[13px] text-pure-black">
                  {t('browser.error')}
                </div>
                <div className="text-[12px] text-[#ef4444] truncate max-w-[240px]">
                  {browserStatus.error}
                </div>
              </div>
            </>
          )}

          {/* Start/Stop button row */}
          <div className="border-t border-light-gray/30" />
          <div className="flex items-center justify-end py-3 px-4">
            <button
              onClick={handleToggleBrowser}
              disabled={browserStatus.state === 'starting'}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-interactive text-[12px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                isRunning
                  ? 'bg-pure-white text-[#ef4444] border border-light-gray/60 hover:bg-snow'
                  : 'bg-pure-black text-pure-white hover:bg-near-black'
              }`}
            >
              {isRunning ? (
                <>
                  <Square className="w-3.5 h-3.5" />
                  {t('browser.stopBrowser')}
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" />
                  {t('browser.startBrowser')}
                </>
              )}
            </button>
          </div>
        </div>
      </section>

      {/* Configuration Section */}
      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="text-[10px] text-silver font-medium uppercase tracking-wider">
            {t('browser.configuration')}
          </div>
        </div>
        <div className="border border-light-gray/60 rounded-container overflow-hidden bg-pure-white">
          {/* Auto-start toggle */}
          <div className="flex items-center justify-between py-3 px-4">
            <div>
              <div className="font-display font-medium text-[13px] text-pure-black">{t('browser.autoStart')}</div>
              <div className="text-[11px] text-stone">{t('browser.autoStartDesc')}</div>
            </div>
            <button
              type="button"
              onClick={() => updateConfig({ enabled: !localConfig.enabled })}
              className={`relative w-12 h-7 rounded-full transition-colors border ${
                localConfig.enabled
                  ? 'bg-pure-black border-pure-black'
                  : 'bg-pure-white border-light-gray'
              }`}
            >
              <div
                className={`absolute top-[1px] w-6 h-6 rounded-full transition-transform ${
                  localConfig.enabled ? 'left-[22px] bg-pure-white' : 'left-[2px] bg-light-gray'
                }`}
              />
            </button>
          </div>

          {/* Headless toggle */}
          <div className="border-t border-light-gray/30" />
          <div className="flex items-center justify-between py-3 px-4">
            <div>
              <div className="font-display font-medium text-[13px] text-pure-black">{t('browser.headlessMode')}</div>
              <div className="text-[11px] text-stone">{t('browser.headlessDesc')}</div>
            </div>
            <button
              type="button"
              onClick={() => updateConfig({ headless: !localConfig.headless })}
              className={`relative w-12 h-7 rounded-full transition-colors border ${
                localConfig.headless
                  ? 'bg-pure-black border-pure-black'
                  : 'bg-pure-white border-light-gray'
              }`}
            >
              <div
                className={`absolute top-[1px] w-6 h-6 rounded-full transition-transform ${
                  localConfig.headless ? 'left-[22px] bg-pure-white' : 'left-[2px] bg-light-gray'
                }`}
              />
            </button>
          </div>

          {/* Viewport Width */}
          <div className="border-t border-light-gray/30" />
          <div className="py-3 px-4">
            <label className="block font-display font-medium text-[13px] text-pure-black mb-1.5">
              {t('browser.viewportWidth')}
            </label>
            <input
              type="number"
              value={localConfig.viewport_width}
              onChange={(e) => updateConfig({ viewport_width: parseInt(e.target.value) || 1280 })}
              min={800}
              max={3840}
              className="w-full px-3 py-2 text-[13px] border border-light-gray/60 rounded-interactive bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors"
            />
          </div>

          {/* Viewport Height */}
          <div className="border-t border-light-gray/30" />
          <div className="py-3 px-4">
            <label className="block font-display font-medium text-[13px] text-pure-black mb-1.5">
              {t('browser.viewportHeight')}
            </label>
            <input
              type="number"
              value={localConfig.viewport_height}
              onChange={(e) => updateConfig({ viewport_height: parseInt(e.target.value) || 720 })}
              min={600}
              max={2160}
              className="w-full px-3 py-2 text-[13px] border border-light-gray/60 rounded-interactive bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors"
            />
          </div>

          {/* Browser Path */}
          <div className="border-t border-light-gray/30" />
          <div className="py-3 px-4">
            <label className="block font-display font-medium text-[13px] text-pure-black mb-1.5">
              {t('browser.browserPath')}
            </label>
            <input
              type="text"
              value={localConfig.browser_path || ''}
              onChange={(e) => updateConfig({ browser_path: e.target.value || null })}
              placeholder={t('browser.browserPathPlaceholder')}
              className="w-full px-3 py-2 text-[13px] border border-light-gray/60 rounded-interactive bg-pure-white text-pure-black placeholder:text-silver focus:outline-none focus:border-pure-black transition-colors"
            />
            <p className="text-[11px] text-stone mt-1">{t('browser.browserPathDesc')}</p>
          </div>

          {/* CDP Port */}
          <div className="border-t border-light-gray/30" />
          <div className="py-3 px-4">
            <label className="block font-display font-medium text-[13px] text-pure-black mb-1.5">
              {t('browser.cdpPortConfig')}
            </label>
            <input
              type="number"
              value={localConfig.cdp_port || ''}
              onChange={(e) => updateConfig({ cdp_port: parseInt(e.target.value) || null })}
              placeholder={t('browser.cdpPortPlaceholder')}
              min={1024}
              max={65535}
              className="w-full px-3 py-2 text-[13px] border border-light-gray/60 rounded-interactive bg-pure-white text-pure-black placeholder:text-silver focus:outline-none focus:border-pure-black transition-colors"
            />
          </div>

          {/* Enable Screenshots toggle */}
          <div className="border-t border-light-gray/30" />
          <div className="flex items-center justify-between py-3 px-4">
            <div>
              <div className="font-display font-medium text-[13px] text-pure-black">{t('browser.enableScreenshots')}</div>
              <div className="text-[11px] text-stone">{t('browser.enableScreenshotsDesc')}</div>
            </div>
            <button
              type="button"
              onClick={() => updateConfig({ enable_screenshots: !localConfig.enable_screenshots })}
              className={`relative w-12 h-7 rounded-full transition-colors border ${
                localConfig.enable_screenshots
                  ? 'bg-pure-black border-pure-black'
                  : 'bg-pure-white border-light-gray'
              }`}
            >
              <div
                className={`absolute top-[1px] w-6 h-6 rounded-full transition-transform ${
                  localConfig.enable_screenshots ? 'left-[22px] bg-pure-white' : 'left-[2px] bg-light-gray'
                }`}
              />
            </button>
          </div>

          {/* Screenshot Interval */}
          <div className="border-t border-light-gray/30" />
          <div className="py-3 px-4">
            <label className="block font-display font-medium text-[13px] text-pure-black mb-1.5">
              {t('browser.screenshotInterval')}
            </label>
            <input
              type="number"
              value={localConfig.screenshot_interval_ms}
              onChange={(e) => updateConfig({ screenshot_interval_ms: parseInt(e.target.value) || 5000 })}
              min={2000}
              max={10000}
              step={100}
              disabled={!localConfig.enable_screenshots}
              className="w-full px-3 py-2 text-[13px] border border-light-gray/60 rounded-interactive bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <p className="text-[11px] text-stone mt-1">{t('browser.screenshotIntervalDesc')}</p>
          </div>
        </div>
      </section>

      {/* Save Button */}
      <div className="flex items-center justify-end gap-3 pt-2">
        {saveError && (
          <span className="text-[11px] text-[#ef4444]">{saveError}</span>
        )}
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-1 px-4 py-2 rounded-interactive text-[12px] font-medium bg-pure-black text-pure-white hover:bg-near-black transition-colors disabled:opacity-50"
        >
          {isSaving ? t('browser.saving') : t('browser.saveConfig')}
        </button>
      </div>
    </div>
  );
}
