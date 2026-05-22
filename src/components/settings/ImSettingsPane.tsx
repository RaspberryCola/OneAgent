import { useState, useEffect } from 'react';
import {
  QrCode,
  Play,
  Square,
  Check,
  CheckCircle,
  AlertTriangle,
  RefreshCw,
  UserCheck,
  Key,
  X,
  HelpCircle,
  Copy,
  Globe,
} from 'lucide-react';
import type * as Types from '../../lib/backend/types';
import * as commands from '../../lib/backend/commands';
import * as events from '../../lib/backend/events';
import { IS_TAURI } from '../../lib/backend/transport';
import { SettingSelect } from './SettingSelect';

interface ImSettingsPaneProps {
  webuiEnabled: boolean;
  webuiPassword: string | null;
  webuiInfo: { port: number; urls: string[] } | null;
  onToggleWebuiEnabled: () => Promise<string | null>;
}

export function ImSettingsPane({
  webuiEnabled,
  webuiPassword,
  webuiInfo,
  onToggleWebuiEnabled,
}: ImSettingsPaneProps) {
  const [selectedTab, setSelectedTab] = useState<'webui' | 'weixin' | 'lark' | 'pairing'>('webui');
  const [plugins, setPlugins] = useState<Types.ImPluginInfo[]>([]);
  const sidecarPath = './im-sidecar/dist/index.js';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // WeChat Form State
  const [wxAccountId, setWxAccountId] = useState('');
  const [wxBotToken, setWxBotToken] = useState('');
  const [wxBaseUrl, setWxBaseUrl] = useState('');
  const [wxScanMode, setWxScanMode] = useState(false);
  const [wxSubTab, setWxSubTab] = useState<'scan' | 'manual'>('scan');
  const [weixinQrUrl, setWeixinQrUrl] = useState<string | null>(null);
  const [weixinScanStep, setWeixinScanStep] = useState<'idle' | 'qr' | 'scanned' | 'done'>('idle');
  const [weixinError, setWeixinError] = useState<string | null>(null);

  // Lark Form State
  const [larkAppId, setLarkAppId] = useState('');
  const [larkAppSecret, setLarkAppSecret] = useState('');
  const [larkEncryptKey, setLarkEncryptKey] = useState('');
  const [larkVerificationToken, setLarkVerificationToken] = useState('');
  const [larkDomain, setLarkDomain] = useState<'feishu' | 'lark'>('feishu');

  // Pairing State
  const [pairingCodeInput, setPairingCodeInput] = useState('');
  const [pairingMessage, setPairingMessage] = useState<string | null>(null);
  const [pairingMessageType, setPairingMessageType] = useState<'success' | 'error' | null>(null);
  const [pendingPairings, setPendingPairings] = useState<events.ImPairingRequestedPayload[]>([]);

  // WebUI copy state
  const [webuiCopied, setWebuiCopied] = useState<string | null>(null);

  const handleWebuiCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setWebuiCopied(text);
    setTimeout(() => setWebuiCopied(null), 2000);
  };

  // Workspaces & Agents lists
  const [workspaces, setWorkspaces] = useState<Types.Workspace[]>([]);
  const [agents, setAgents] = useState<Types.AgentProfile[]>([]);

  // WeChat Routing State
  const [wxWorkspaceId, setWxWorkspaceId] = useState('');
  const [wxAgentProfileId, setWxAgentProfileId] = useState('');

  // Lark Routing State
  const [larkWorkspaceId, setLarkWorkspaceId] = useState('');
  const [larkAgentProfileId, setLarkAgentProfileId] = useState('');

  // Sync routing configuration from backend plugin info — only on mount
  useEffect(() => {
    const wx = plugins.find((p) => p.platform === 'weixin');
    if (wx) {
      setWxWorkspaceId(wx.workspace_id || '');
      setWxAgentProfileId(wx.agent_profile_id || '');
    }
    const lark = plugins.find((p) => p.platform === 'lark');
    if (lark) {
      setLarkWorkspaceId(lark.workspace_id || '');
      setLarkAgentProfileId(lark.agent_profile_id || '');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load workspaces and agents on mount
  useEffect(() => {
    const loadWorkspacesAndAgents = async () => {
      try {
        const wsList = await commands.listWorkspaces();
        setWorkspaces(wsList);
        const agentList = await commands.listAgentProfiles();
        setAgents(agentList.filter((a) => a.enabled));
      } catch (err) {
        console.error('Failed to load workspaces or agents:', err);
      }
    };
    loadWorkspacesAndAgents();
  }, []);

  const handleUpdateWeixinConfig = async (wsId: string, agentId: string) => {
    setWxWorkspaceId(wsId);
    setWxAgentProfileId(agentId);
    const wx = plugins.find((p) => p.platform === 'weixin');
    if (wx?.enabled) {
      try {
        await commands.updateImPluginConfig('weixin', wsId || undefined, agentId || undefined);
        await refreshPlugins();
      } catch (err: any) {
        setError(err.message || 'Failed to update WeChat configuration');
      }
    }
  };

  const handleUpdateLarkConfig = async (wsId: string, agentId: string) => {
    setLarkWorkspaceId(wsId);
    setLarkAgentProfileId(agentId);
    const lark = plugins.find((p) => p.platform === 'lark');
    if (lark?.enabled) {
      try {
        await commands.updateImPluginConfig('lark', wsId || undefined, agentId || undefined);
        await refreshPlugins();
      } catch (err: any) {
        setError(err.message || 'Failed to update Feishu configuration');
      }
    }
  };

  // Fetch plugins status
  const refreshPlugins = async () => {
    try {
      const list = await commands.listImPlugins();
      setPlugins(list);
    } catch (err: any) {
      console.error('Failed to list IM plugins:', err);
      setError(err.message || 'Failed to query IM plugins status');
    }
  };

  useEffect(() => {
    refreshPlugins();
    
    // Set up polling for plugin status every 3 seconds to keep UI synced
    const interval = setInterval(refreshPlugins, 3000);
    return () => clearInterval(interval);
  }, []);

  // Listen to IM events from backend
  useEffect(() => {
    let unlistenPairing: (() => void) | null = null;
    let unlistenQr: (() => void) | null = null;
    let unlistenScanned: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;
    let unlistenAuth: (() => void) | null = null;

    const setupListeners = async () => {
      unlistenPairing = await events.onImPairingRequested((payload) => {
        setPendingPairings((prev) => {
          // Prevent duplicates
          if (prev.some((p) => p.code === payload.code)) return prev;
          return [payload, ...prev];
        });
      });

      unlistenQr = await events.onImWeixinLoginQr((payload) => {
        setWeixinQrUrl(payload.qr_url);
        setWeixinScanStep('qr');
      });

      unlistenScanned = await events.onImWeixinLoginScanned(() => {
        setWeixinScanStep('scanned');
      });

      unlistenDone = await events.onImWeixinLoginDone(async (payload) => {
        setWeixinScanStep('done');
        try {
          // Automatically start the WeChat plugin using the credentials received
          await commands.startImPlugin(
            'weixin',
            sidecarPath,
            JSON.stringify({
              accountId: payload.account_id,
              botToken: payload.bot_token,
              baseUrl: wxBaseUrl || undefined,
            }),
            wxWorkspaceId || undefined,
            wxAgentProfileId || undefined
          );
          // Stop WeChat login process
          await commands.stopWeixinLogin();
          setTimeout(() => {
            setWxScanMode(false);
            setWeixinQrUrl(null);
            setWeixinScanStep('idle');
            refreshPlugins();
          }, 2000);
        } catch (err: any) {
          setWeixinError(err.message || 'Failed to auto-start WeChat bot after login');
        }
      });

      unlistenAuth = await events.onImUserAuthorized((payload) => {
        // Remove from pending pairings if matching
        setPendingPairings((prev) => 
          prev.filter((p) => p.platform_user_id !== payload.platform_user_id || p.platform_type !== payload.platform_type)
        );
        refreshPlugins();
      });
    };

    setupListeners();

    return () => {
      if (unlistenPairing) unlistenPairing();
      if (unlistenQr) unlistenQr();
      if (unlistenScanned) unlistenScanned();
      if (unlistenDone) unlistenDone();
      if (unlistenAuth) unlistenAuth();
    };
  }, [wxBaseUrl, wxWorkspaceId, wxAgentProfileId]);

  // WeChat Actions
  const handleStartWeixinLogin = async () => {
    setWeixinError(null);
    setWeixinScanStep('idle');
    setWeixinQrUrl(null);
    setWxScanMode(true);
    try {
      await commands.startWeixinLogin(sidecarPath);
    } catch (err: any) {
      setWeixinError(err.message || 'Failed to start WeChat scan login');
      setWxScanMode(false);
    }
  };

  const handleCancelWeixinLogin = async () => {
    try {
      await commands.stopWeixinLogin();
    } catch (err) {
      console.error(err);
    }
    setWxScanMode(false);
    setWeixinQrUrl(null);
    setWeixinScanStep('idle');
    setWeixinError(null);
  };

  const handleSaveWeixinManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wxAccountId || !wxBotToken) return;
    setLoading(true);
    setError(null);
    try {
      await commands.startImPlugin(
        'weixin',
        sidecarPath,
        JSON.stringify({
          accountId: wxAccountId,
          botToken: wxBotToken,
          baseUrl: wxBaseUrl || undefined,
        }),
        wxWorkspaceId || undefined,
        wxAgentProfileId || undefined
      );
      await refreshPlugins();
    } catch (err: any) {
      setError(err.message || 'Failed to start WeChat plugin manually');
    } finally {
      setLoading(false);
    }
  };

  const handleStopWeixin = async () => {
    setLoading(true);
    try {
      await commands.stopImPlugin('weixin');
      await refreshPlugins();
    } catch (err: any) {
      setError(err.message || 'Failed to stop WeChat plugin');
    } finally {
      setLoading(false);
    }
  };

  // Lark Actions
  const handleStartLark = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!larkAppId || !larkAppSecret) return;
    setLoading(true);
    setError(null);
    try {
      await commands.startImPlugin(
        'lark',
        sidecarPath,
        JSON.stringify({
          appId: larkAppId,
          appSecret: larkAppSecret,
          encryptKey: larkEncryptKey || undefined,
          verificationToken: larkVerificationToken || undefined,
          domain: larkDomain,
        }),
        larkWorkspaceId || undefined,
        larkAgentProfileId || undefined
      );
      await refreshPlugins();
    } catch (err: any) {
      setError(err.message || 'Failed to start Feishu plugin');
    } finally {
      setLoading(false);
    }
  };

  const handleStopLark = async () => {
    setLoading(true);
    try {
      await commands.stopImPlugin('lark');
      await refreshPlugins();
    } catch (err: any) {
      setError(err.message || 'Failed to stop Feishu plugin');
    } finally {
      setLoading(false);
    }
  };

  // Pairing actions
  const handleApprovePairing = async (code: string) => {
    setPairingMessage(null);
    try {
      const res = await commands.approveImPairing(code);
      setPairingMessage(res || 'Pairing code approved successfully!');
      setPairingMessageType('success');
      // Clear input
      if (code === pairingCodeInput) {
        setPairingCodeInput('');
      }
      // Remove from pending lists
      setPendingPairings((prev) => prev.filter((p) => p.code !== code));
    } catch (err: any) {
      setPairingMessage(err.message || 'Failed to approve pairing code');
      setPairingMessageType('error');
    }
  };

  const weixinPlugin = plugins.find((p) => p.platform === 'weixin');
  const larkPlugin = plugins.find((p) => p.platform === 'lark');

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'connected':
        return 'bg-pure-black text-pure-white';
      case 'connecting':
        return 'bg-light-gray text-near-black';
      case 'error':
        return 'bg-mid-gray text-pure-white';
      default:
        return 'bg-stone text-pure-white';
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 bg-snow rounded-interactive p-1 mb-5 w-fit">
        {IS_TAURI && (
          <button
            onClick={() => setSelectedTab('webui')}
            className={`px-3 py-1.5 text-[12px] font-medium rounded-interactive transition-colors ${
              selectedTab === 'webui'
                ? 'bg-light-gray text-near-black'
                : 'bg-transparent text-stone hover:text-pure-black'
            }`}
          >
            WebUI Access
          </button>
        )}
        <button
          onClick={() => setSelectedTab('weixin')}
          className={`px-3 py-1.5 text-[12px] font-medium rounded-interactive transition-colors ${
            selectedTab === 'weixin'
              ? 'bg-light-gray text-near-black'
              : 'bg-transparent text-stone hover:text-pure-black'
          }`}
        >
          WeChat Bot
        </button>
        <button
          onClick={() => setSelectedTab('lark')}
          className={`px-3 py-1.5 text-[12px] font-medium rounded-interactive transition-colors ${
            selectedTab === 'lark'
              ? 'bg-light-gray text-near-black'
              : 'bg-transparent text-stone hover:text-pure-black'
          }`}
        >
          Feishu Bot
        </button>
        <button
          onClick={() => setSelectedTab('pairing')}
          className={`px-3 py-1.5 text-[12px] font-medium rounded-interactive transition-colors flex items-center gap-1.5 ${
            selectedTab === 'pairing'
              ? 'bg-light-gray text-near-black'
              : 'bg-transparent text-stone hover:text-pure-black'
          }`}
        >
          Pairing Codes
          {pendingPairings.length > 0 && (
            <span className="w-1.5 h-1.5 rounded-full bg-pure-black animate-pulse" />
          )}
        </button>
      </div>

      {error && (
        <div className="flex gap-3 p-3 rounded-container bg-light-gray/20 border border-light-gray text-near-black text-[11px] leading-relaxed">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-6 pb-2">
      {/* WebUI Access Tab */}
      {selectedTab === 'webui' && IS_TAURI && (
        <div className="border border-light-gray/60 rounded-container bg-pure-white">
          <div className="flex items-center justify-between py-3 px-4">
            <div className="flex flex-col gap-0.5">
              <span className="font-display font-medium text-[13px] text-pure-black">
                Enable WebUI Access
              </span>
              <span className="text-[11px] text-stone">
                Allows remote web browser access on port {webuiInfo?.port ?? 19520}, LAN enabled
              </span>
            </div>
            <button
              onClick={onToggleWebuiEnabled}
              className={`relative w-12 h-7 rounded-full transition-colors border ${
                webuiEnabled
                  ? 'bg-pure-black border-pure-black'
                  : 'bg-pure-white border-light-gray'
              }`}
            >
              <div
                className={`absolute top-[1px] w-6 h-6 rounded-full transition-transform ${
                  webuiEnabled ? 'left-[22px] bg-pure-white' : 'left-[2px] bg-light-gray'
                }`}
              />
            </button>
          </div>

          {/* Access URLs + Password — shown when WebUI is enabled */}
          {webuiEnabled && (
            <div className="border-t border-light-gray/60 px-4 py-3 space-y-4">
              {/* URLs */}
              {webuiInfo && webuiInfo.urls.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Globe className="w-4 h-4 text-stone" />
                    <span className="font-display font-medium text-[13px] text-pure-black">Access URLs</span>
                  </div>
                  <div className="space-y-1.5">
                    {webuiInfo.urls.map((url) => (
                      <div key={url} className="flex items-center gap-2">
                        <code className="flex-1 px-3 py-1.5 bg-snow border border-light-gray/60 rounded-interactive text-[12px] font-mono text-pure-black truncate overflow-hidden" title={url}>
                          {url}
                        </code>
                        <button
                          onClick={() => handleWebuiCopy(url)}
                          className="flex items-center gap-1 px-2 py-1.5 rounded-interactive text-[10px] font-medium border border-light-gray text-stone hover:bg-snow hover:text-pure-black bg-pure-white transition-colors shrink-0"
                        >
                          {webuiCopied === url ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        </button>
                      </div>
                    ))}
                  </div>
                  {webuiInfo.urls.length > 1 && (
                    <p className="text-[10px] text-silver">
                      Use the second URL to access from other devices on the same network.
                    </p>
                  )}
                </div>
              )}

              {/* Password */}
              {webuiPassword && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Key className="w-4 h-4 text-stone" />
                    <span className="font-display font-medium text-[13px] text-pure-black">Access Password</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-3 py-1.5 bg-snow border border-light-gray/60 rounded-interactive text-[12px] font-mono text-pure-black select-all">
                      {webuiPassword}
                    </code>
                    <button
                      onClick={() => handleWebuiCopy(webuiPassword)}
                      className="flex items-center gap-1 px-2 py-1.5 rounded-interactive text-[10px] font-medium border border-light-gray text-stone hover:bg-snow hover:text-pure-black bg-pure-white transition-colors shrink-0"
                    >
                      {webuiCopied === webuiPassword ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* WeChat Tab */}
      {selectedTab === 'weixin' && (
        <div className="space-y-5">
          {weixinPlugin?.enabled ? (
            <section className="space-y-3">
              <div className="border border-light-gray/60 rounded-container p-4 bg-pure-white space-y-4">
                <div className="flex items-center gap-2">
                  <span className="font-display font-medium text-[13px] text-pure-black">WeChat Bot</span>
                  <span className={`w-2 h-2 rounded-full ${
                    weixinPlugin.status === 'connected' ? 'bg-green' :
                    weixinPlugin.status === 'connecting' ? 'bg-yellow animate-pulse' :
                    weixinPlugin.status === 'error' ? 'bg-rose-500' :
                    'bg-stone'
                  }`} />
                </div>
                <p className="text-[11px] text-stone leading-relaxed">
                  WeChat Personal Bot integration is active. The sidecar handles user interaction via iLink Bot APIs.
                </p>
                <div className="pt-2">
                  <button
                    onClick={handleStopWeixin}
                    disabled={loading}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-interactive text-[11px] font-medium transition-colors border border-mid-gray text-mid-gray hover:bg-snow bg-pure-white"
                  >
                    <Square className="w-3 h-3" />
                    <span>Stop WeChat Bot</span>
                  </button>
                </div>
              </div>
            </section>
          ) : (
            <section className="space-y-4">
              {/* Single card with tab switcher inside */}
              <div className="border border-light-gray/60 rounded-container bg-pure-white">
                {/* Tab switcher */}
                <div className="flex gap-1 px-3 py-2 border-b border-light-gray/40">
                  <button
                    onClick={() => setWxSubTab('scan')}
                    title="Log in to WeChat Bot by scanning a dynamic QR code"
                    className={`px-3 py-1.5 text-[12px] font-medium rounded-interactive transition-colors ${
                      wxSubTab === 'scan'
                        ? 'bg-light-gray text-near-black'
                        : 'bg-transparent text-stone hover:text-pure-black'
                    }`}
                  >
                    Scan Login
                  </button>
                  <button
                    onClick={() => setWxSubTab('manual')}
                    title="Enter iLink Bot Account ID and Token manually"
                    className={`px-3 py-1.5 text-[12px] font-medium rounded-interactive transition-colors ${
                      wxSubTab === 'manual'
                        ? 'bg-light-gray text-near-black'
                        : 'bg-transparent text-stone hover:text-pure-black'
                    }`}
                  >
                    Manual Configuration
                  </button>
                </div>

                {/* Scan Login Panel */}
                {wxSubTab === 'scan' && (
                  <div className="p-4">
                    {wxScanMode ? (
                      <div className="flex flex-col items-center justify-center space-y-4">
                        {weixinError && (
                          <div className="w-full flex gap-3 p-3 rounded-container bg-light-gray/20 border border-light-gray text-near-black text-[11px] leading-relaxed">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            <div>{weixinError}</div>
                          </div>
                        )}

                        {weixinQrUrl ? (
                          <div className="p-2 border border-light-gray bg-pure-white rounded-container">
                            <img src={weixinQrUrl} alt="WeChat Login QR Code" className="w-48 h-48" />
                          </div>
                        ) : (
                          <div className="w-48 h-48 border border-dashed border-light-gray rounded-container flex flex-col items-center justify-center text-stone text-[11px] gap-2 bg-snow">
                            <RefreshCw className="w-4 h-4 animate-spin text-silver" />
                            <span>Generating QR Code...</span>
                          </div>
                        )}

                        <div className="text-center space-y-1">
                          <span className="text-[12px] font-medium text-pure-black">
                            {weixinScanStep === 'idle' && 'Initializing login bridge...'}
                            {weixinScanStep === 'qr' && 'Please scan this code using your phone\'s WeChat app.'}
                            {weixinScanStep === 'scanned' && 'Scan detected! Please confirm login on your mobile WeChat app.'}
                            {weixinScanStep === 'done' && 'Login successful! Setting up bot channel...'}
                          </span>
                          <p className="text-[10px] text-silver leading-relaxed max-w-sm">
                            WeChat Bot operates using Tencent iLink API. The QR code links your personal WeChat bot assistant.
                          </p>
                        </div>

                        <button
                          onClick={handleCancelWeixinLogin}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-interactive text-[11px] font-medium border border-light-gray text-stone hover:bg-snow hover:text-pure-black bg-pure-white"
                        >
                          <X className="w-3.5 h-3.5" />
                          <span>Cancel Login</span>
                        </button>
                      </div>
                    ) : (
                      <div>
                        <button
                          onClick={handleStartWeixinLogin}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-interactive text-[11px] font-medium bg-pure-black text-pure-white border border-pure-black hover:bg-near-black"
                        >
                          <QrCode className="w-3.5 h-3.5" />
                          <span>Start WeChat Scan Login</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Manual Configuration Panel */}
                {wxSubTab === 'manual' && (
                  <div className="p-4 space-y-3">
                    <form onSubmit={handleSaveWeixinManual} className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] font-medium text-stone uppercase tracking-wide">Account ID</label>
                          <input
                            type="text"
                            required
                            value={wxAccountId}
                            onChange={(e) => setWxAccountId(e.target.value)}
                            placeholder="e.g. wx_account_xxx"
                            className="w-full px-3 py-1.5 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors font-mono"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] font-medium text-stone uppercase tracking-wide">Bot Token</label>
                          <input
                            type="password"
                            required
                            value={wxBotToken}
                            onChange={(e) => setWxBotToken(e.target.value)}
                            placeholder="WeChat Bot API Token"
                            className="w-full px-3 py-1.5 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors font-mono"
                          />
                        </div>
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-medium text-stone uppercase tracking-wide">Base URL (Optional)</label>
                        <input
                          type="text"
                          value={wxBaseUrl}
                          onChange={(e) => setWxBaseUrl(e.target.value)}
                          placeholder="https://ilinkai.weixin.qq.com"
                          className="w-full px-3 py-1.5 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors font-mono"
                        />
                      </div>

                      <div className="pt-2">
                        <button
                          type="submit"
                          disabled={loading || !wxAccountId || !wxBotToken}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-interactive text-[11px] font-medium bg-pure-black text-pure-white border border-pure-black hover:bg-near-black disabled:opacity-50"
                        >
                          <Play className="w-3 h-3" />
                          <span>Save & Start Manual Bot</span>
                        </button>
                      </div>
                    </form>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Session Routing Configuration — moved to bottom */}
          <div className="border border-light-gray/60 rounded-container p-4 bg-pure-white space-y-4">
            <div className="flex flex-col gap-1 border-b border-light-gray/40 pb-2 mb-1">
              <span className="font-display font-medium text-[13px] text-pure-black">Session Routing Configuration</span>
              <span className="text-[11px] text-stone">Specify which Workspace and Agent Profile will handle incoming WeChat messages on this channel.</span>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <SettingSelect
                value={wxWorkspaceId}
                onChange={(v) => handleUpdateWeixinConfig(v, wxAgentProfileId)}
                placeholder="Default Workspace (First Available)"
                label="Workspace"
                options={[
                  { value: '', label: 'Default Workspace (First Available)' },
                  ...workspaces.map((ws) => ({ value: ws.id, label: ws.display_name || ws.cwd })),
                ]}
              />
              <SettingSelect
                value={wxAgentProfileId}
                onChange={(v) => handleUpdateWeixinConfig(wxWorkspaceId, v)}
                placeholder="Default Agent (First Enabled)"
                label="Agent Profile"
                options={[
                  { value: '', label: 'Default Agent (First Enabled)' },
                  ...agents.map((a) => ({ value: a.id, label: a.name })),
                ]}
              />
            </div>
          </div>
        </div>
      )}

      {/* Lark Tab */}
      {selectedTab === 'lark' && (
        <div className="space-y-4">
          {larkPlugin?.enabled ? (
            <div className="border border-light-gray/60 rounded-container p-4 bg-pure-white space-y-4">
              <div className="flex items-center gap-2">
                <span className="font-display font-medium text-[13px] text-pure-black">Feishu Bot</span>
                <span className={`w-2 h-2 rounded-full ${
                  larkPlugin.status === 'connected' ? 'bg-green' :
                  larkPlugin.status === 'connecting' ? 'bg-yellow animate-pulse' :
                  larkPlugin.status === 'error' ? 'bg-rose-500' :
                  'bg-stone'
                }`} />
              </div>
              <p className="text-[11px] text-stone leading-relaxed">
                Feishu / Lark WebSocket plugin is active. The sidecar listens for message packets directly from Lark servers.
              </p>
              <div className="pt-2">
                <button
                  onClick={handleStopLark}
                  disabled={loading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-interactive text-[11px] font-medium transition-colors border border-mid-gray text-mid-gray hover:bg-snow bg-pure-white"
                >
                  <Square className="w-3 h-3" />
                  <span>Stop Feishu Bot</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="border border-light-gray/60 rounded-container p-4 bg-pure-white space-y-4">
              <div className="flex flex-col gap-1">
                <span className="font-display font-medium text-[13px] text-pure-black">Feishu Configuration</span>
                <span className="text-[11px] text-stone">Provide your self-built Feishu Application App ID and Secret.</span>
              </div>

              <form onSubmit={handleStartLark} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-medium text-stone uppercase tracking-wide">App ID</label>
                    <input
                      type="text"
                      required
                      value={larkAppId}
                      onChange={(e) => setLarkAppId(e.target.value)}
                      placeholder="cli_xxx"
                      className="w-full px-3 py-1.5 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors font-mono"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-medium text-stone uppercase tracking-wide">App Secret</label>
                    <input
                      type="password"
                      required
                      value={larkAppSecret}
                      onChange={(e) => setLarkAppSecret(e.target.value)}
                      placeholder="Feishu App Secret"
                      className="w-full px-3 py-1.5 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-medium text-stone uppercase tracking-wide">Encrypt Key (Optional)</label>
                    <input
                      type="text"
                      value={larkEncryptKey}
                      onChange={(e) => setLarkEncryptKey(e.target.value)}
                      placeholder="Encrypt Key for messages"
                      className="w-full px-3 py-1.5 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors font-mono"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-medium text-stone uppercase tracking-wide">Verification Token (Optional)</label>
                    <input
                      type="text"
                      value={larkVerificationToken}
                      onChange={(e) => setLarkVerificationToken(e.target.value)}
                      placeholder="Verification Token"
                      className="w-full px-3 py-1.5 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors font-mono"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-medium text-stone uppercase tracking-wide">Platform Domain</label>
                  <select
                    value={larkDomain}
                    onChange={(e) => setLarkDomain(e.target.value as 'feishu' | 'lark')}
                    className="w-full px-3 py-1.5 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors"
                  >
                    <option value="feishu">Feishu (open.feishu.cn)</option>
                    <option value="lark">Lark Global (open.larksuite.com)</option>
                  </select>
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    disabled={loading || !larkAppId || !larkAppSecret}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-interactive text-[11px] font-medium bg-pure-black text-pure-white border border-pure-black hover:bg-near-black disabled:opacity-50"
                  >
                    <Play className="w-3 h-3" />
                    <span>Save & Start Feishu Bot</span>
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Session Routing Configuration */}
          <div className="border border-light-gray/60 rounded-container p-4 bg-pure-white space-y-4">
            <div className="flex flex-col gap-1 border-b border-light-gray/40 pb-2 mb-1">
              <span className="font-display font-medium text-[13px] text-pure-black">Session Routing Configuration</span>
              <span className="text-[11px] text-stone">Specify which Workspace and Agent Profile will handle incoming Feishu messages on this channel.</span>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <SettingSelect
                value={larkWorkspaceId}
                onChange={(v) => handleUpdateLarkConfig(v, larkAgentProfileId)}
                placeholder="Default Workspace (First Available)"
                label="Workspace"
                options={[
                  { value: '', label: 'Default Workspace (First Available)' },
                  ...workspaces.map((ws) => ({ value: ws.id, label: ws.display_name || ws.cwd })),
                ]}
              />
              <SettingSelect
                value={larkAgentProfileId}
                onChange={(v) => handleUpdateLarkConfig(larkWorkspaceId, v)}
                placeholder="Default Agent (First Enabled)"
                label="Agent Profile"
                options={[
                  { value: '', label: 'Default Agent (First Enabled)' },
                  ...agents.map((a) => ({ value: a.id, label: a.name })),
                ]}
              />
            </div>
          </div>
        </div>
      )}

      {/* Pairing Codes Tab */}
      {selectedTab === 'pairing' && (
        <div className="space-y-4">
          <div className="border border-light-gray/60 rounded-container p-4 bg-pure-white space-y-4">
            <div className="flex flex-col gap-1">
              <span className="font-display font-medium text-[13px] text-pure-black">Pairing Authorization</span>
              <span className="text-[11px] text-stone">
                Linking an external IM account (WeChat or Feishu) to this agent core. When an unauthorized user sends a message, they receive a pairing code. Enter the 6-digit code below to approve them.
              </span>
            </div>

            {pairingMessage && (
              <div className="flex gap-3 p-3 rounded-container bg-light-gray/20 border border-light-gray text-near-black text-[11px] leading-relaxed">
                {pairingMessageType === 'success' ? (
                  <CheckCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                )}
                <div>{pairingMessage}</div>
              </div>
            )}

            <div className="flex gap-2 max-w-sm">
              <input
                type="text"
                maxLength={6}
                value={pairingCodeInput}
                onChange={(e) => setPairingCodeInput(e.target.value.trim())}
                placeholder="Enter 6-digit code"
                className="w-full px-3 py-1.5 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors font-mono tracking-widest text-center text-lg"
              />
              <button
                onClick={() => handleApprovePairing(pairingCodeInput)}
                disabled={pairingCodeInput.length !== 6}
                className="flex items-center justify-center gap-1.5 px-4 py-1.5 rounded-interactive text-[11px] font-medium bg-pure-black text-pure-white border border-pure-black hover:bg-near-black disabled:opacity-50 shrink-0"
              >
                <UserCheck className="w-3.5 h-3.5" />
                <span>Approve</span>
              </button>
            </div>
          </div>

          <div className="border border-light-gray/60 rounded-container p-4 bg-pure-white space-y-3">
            <div className="flex items-center justify-between mb-1">
              <div className="text-[10px] text-silver font-medium uppercase tracking-wider">Dynamic Session Pairing Requests</div>
              {pendingPairings.length > 0 && (
                <button
                  onClick={() => setPendingPairings([])}
                  className="text-[10px] text-stone hover:text-pure-black"
                >
                  Clear List
                </button>
              )}
            </div>

            {pendingPairings.length === 0 ? (
              <p className="text-[11px] text-stone italic text-center py-4">
                No active pairing requests. Send a message to your WeChat/Feishu bot to request a new code.
              </p>
            ) : (
              <div className="divide-y divide-light-gray/30">
                {pendingPairings.map((req) => (
                  <div key={req.code} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-display font-medium text-[12px] text-pure-black">
                        {req.display_name} ({req.platform_user_id})
                      </span>
                      <span className="text-[10px] text-silver">
                        Platform: <span className="font-medium text-stone uppercase">{req.platform_type}</span>
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-[13px] font-medium text-pure-black tracking-widest bg-snow border border-light-gray/40 px-2 py-0.5 rounded-interactive">
                        {req.code}
                      </span>
                      <button
                        onClick={() => handleApprovePairing(req.code)}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-interactive text-[10px] font-medium border border-light-gray text-stone hover:bg-snow hover:text-pure-black bg-pure-white transition-colors"
                      >
                        <Check className="w-3 h-3" />
                        <span>Approve</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
