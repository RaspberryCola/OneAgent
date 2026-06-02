import { useEffect, useRef, useState, useCallback } from 'react';
import { Globe, Play, Square, X, ArrowLeft, ArrowRight, RefreshCw, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../lib/store';
import type { BrowserState } from '../../lib/backend/types';

interface BrowserPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

const MIN_WIDTH = 320;
const MAX_WIDTH = 960;
const DEFAULT_WIDTH = 480;

function StatusBadge({ state }: { state: BrowserState }) {
  const { t } = useTranslation('settings');
  const config: Record<BrowserState, { dot: string; labelKey: string; pulse: boolean }> = {
    stopped: { dot: 'bg-stone-400', labelKey: 'browser.stopped', pulse: false },
    starting: { dot: 'bg-amber-500', labelKey: 'browser.starting', pulse: true },
    running: { dot: 'bg-emerald-500', labelKey: 'browser.running', pulse: false },
    error: { dot: 'bg-rose-500', labelKey: 'browser.error', pulse: false },
  };
  const { dot, labelKey, pulse } = config[state];
  return (
    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-interactive bg-snow border border-light-gray">
      <div className={`w-1.5 h-1.5 rounded-full ${dot} ${pulse ? 'animate-pulse' : ''}`} />
      <span className="text-[11px] font-medium text-stone uppercase tracking-tight">{t(labelKey)}</span>
    </div>
  );
}

export function BrowserPanel({ isOpen, onClose }: BrowserPanelProps) {
  const { t } = useTranslation('settings');
  const {
    browserStatus,
    browserScreenshot,
    browserUrl,
    browserPageTitle,
    browserNavigating,
    startBrowser,
    stopBrowser,
    navigateBrowser,
    browserReload,
    browserGoBack,
    browserGoForward,
  } = useAppStore();

  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [isDragging, setIsDragging] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const screenshotRef = useRef<HTMLImageElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Sync URL input with browser URL
  useEffect(() => {
    if (browserUrl && !browserNavigating) {
      setUrlInput(browserUrl);
    }
  }, [browserUrl, browserNavigating]);

  useEffect(() => {
    if (screenshotRef.current) {
      screenshotRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [browserScreenshot]);

  useEffect(() => {
    return () => { dragCleanupRef.current?.(); };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);

    const startX = e.clientX;
    const startWidth = width;

    const onMouseMove = (e: MouseEvent) => {
      const delta = startX - e.clientX;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
      setWidth(newWidth);
    };

    const onMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      dragCleanupRef.current = null;
    };

    dragCleanupRef.current = onMouseUp;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [width]);

  const handleToggle = async () => {
    if (browserStatus.state === 'running' || browserStatus.state === 'starting') {
      await stopBrowser();
    } else {
      await startBrowser();
    }
  };

  const handleNavigate = async () => {
    let url = urlInput.trim();
    if (!url) return;

    // Add protocol if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    try {
      await navigateBrowser(url);
    } catch (error) {
      console.error('Navigation failed:', error);
    }
  };

  const handleUrlKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleNavigate();
    }
  };

  if (!isOpen) return null;

  return (
    <aside
      className={`bg-snow relative flex-shrink-0 border-l border-light-gray ${
        isDragging ? '' : 'transition-all duration-200'
      } ${isOpen ? '' : 'w-0 overflow-hidden'}`}
      style={isOpen ? { width } : undefined}
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/20 z-10"
        onMouseDown={handleMouseDown}
      />

      <div className="h-full flex flex-col" style={isOpen ? { width } : undefined}>
        {/* Header */}
        <div className="px-4 py-3 border-b border-light-gray/40 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Globe className="w-4 h-4 text-stone shrink-0" />
            <span className="text-[13px] font-medium text-near-black">{t('browser.title')}</span>
            <StatusBadge state={browserStatus.state} />
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleToggle}
              className={`p-1.5 rounded-interactive transition-colors ${
                browserStatus.state === 'running' || browserStatus.state === 'starting'
                  ? 'text-rose-500 hover:bg-rose-50'
                  : 'text-emerald-600 hover:bg-emerald-50'
              }`}
              title={browserStatus.state === 'running' ? t('browser.stopBrowser') : t('browser.startBrowser')}
            >
              {browserStatus.state === 'running' || browserStatus.state === 'starting' ? (
                <Square className="w-3.5 h-3.5" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-interactive text-stone hover:text-near-black hover:bg-light-gray/50 transition-colors"
              title={t('browser.closePanel')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* URL Bar */}
        {browserStatus.state === 'running' && (
          <div className="px-3 py-2 border-b border-light-gray/40 bg-snow/50 shrink-0">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={browserGoBack}
                className="p-1 rounded-interactive text-stone hover:text-near-black hover:bg-light-gray/50 transition-colors"
                title={t('browser.back')}
              >
                <ArrowLeft className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={browserGoForward}
                className="p-1 rounded-interactive text-stone hover:text-near-black hover:bg-light-gray/50 transition-colors"
                title={t('browser.forward')}
              >
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={browserReload}
                className="p-1 rounded-interactive text-stone hover:text-near-black hover:bg-light-gray/50 transition-colors"
                title={t('browser.refresh')}
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <div className="flex-1 relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone" />
                <input
                  ref={urlInputRef}
                  type="text"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={handleUrlKeyDown}
                  placeholder={t('browser.addressBar')}
                  className="w-full pl-7 pr-2 py-1 text-[12px] bg-white border border-light-gray rounded-interactive focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
            {browserPageTitle && (
              <div className="mt-1 text-[11px] text-stone truncate" title={browserPageTitle}>
                {browserPageTitle}
              </div>
            )}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto bg-white">
          {browserStatus.state === 'stopped' && (
            <div className="flex flex-col items-center justify-center h-full text-stone">
              <Globe className="w-12 h-12 mb-3 opacity-30" />
              <p className="text-[13px]">{t('browser.notRunning')}</p>
              <button
                onClick={() => startBrowser()}
                className="mt-3 px-4 py-2 text-[13px] bg-primary text-primary-foreground rounded-interactive hover:bg-primary/90 transition-colors"
              >
                {t('browser.startBrowser')}
              </button>
            </div>
          )}

          {browserStatus.state === 'starting' && (
            <div className="flex flex-col items-center justify-center h-full text-stone">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-[13px]">{t('browser.startingSession')}</p>
            </div>
          )}

          {browserStatus.state === 'error' && (
            <div className="flex flex-col items-center justify-center h-full text-rose-500 px-4">
              <Globe className="w-12 h-12 mb-3 opacity-50" />
              <p className="text-[13px] font-medium">{t('browser.errorTitle')}</p>
              {browserStatus.error && (
                <p className="text-[12px] text-stone mt-1 text-center break-all">{browserStatus.error}</p>
              )}
              <button
                onClick={() => startBrowser()}
                className="mt-3 px-4 py-2 text-[13px] bg-primary text-primary-foreground rounded-interactive hover:bg-primary/90 transition-colors"
              >
                {t('browser.retry')}
              </button>
            </div>
          )}

          {browserStatus.state === 'running' && !browserScreenshot && (
            <div className="flex flex-col items-center justify-center h-full text-stone">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-[13px]">{t('browser.waitingScreenshot')}</p>
            </div>
          )}

          {browserScreenshot && (
            <div className="p-2">
              <img
                ref={screenshotRef}
                src={`data:image/png;base64,${browserScreenshot}`}
                alt="Browser screenshot"
                className="w-full h-auto border border-light-gray rounded shadow-sm"
              />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
