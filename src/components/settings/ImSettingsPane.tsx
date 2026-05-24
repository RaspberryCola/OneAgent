import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
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
  Eye,
  EyeOff,
} from 'lucide-react';
import type * as Types from '../../lib/backend/types';
import * as commands from '../../lib/backend/commands';
import * as events from '../../lib/backend/events';
import { IS_TAURI } from '../../lib/backend/transport';
import { SettingSelect } from './SettingSelect';
import { SettingSelectWithSearch } from './SettingSelectWithSearch';

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
  const { t } = useTranslation("settings");
  const [selectedTab, setSelectedTab] = useState<'webui' | 'weixin' | 'lark'>('webui');
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

  // Derived state: 判断当前是否在 Bot Channels 分类下
  const isBotChannelsActive = selectedTab === 'weixin' || selectedTab === 'lark';

  // 按渠道分组的待处理配对请求
  const weixinPendingPairings = useMemo(
    () => pendingPairings.filter(p => p.platform_type === 'weixin'),
    [pendingPairings]
  );

  const larkPendingPairings = useMemo(
    () => pendingPairings.filter(p => p.platform_type === 'lark'),
    [pendingPairings]
  );

  // 按渠道清除配对请求
  const clearChannelPairings = (platformType: 'weixin' | 'lark') => {
    setPendingPairings(prev => prev.filter(p => p.platform_type !== platformType));
  };

  // WebUI copy state
  const [webuiCopied, setWebuiCopied] = useState<string | null>(null);
  const [passwordVisible, setPasswordVisible] = useState(false);

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
  const [wxModelId, setWxModelId] = useState('');
  const [wxAvailableModels, setWxAvailableModels] = useState<Types.AcpAvailableModel[]>([]);

  // Lark Routing State
  const [larkWorkspaceId, setLarkWorkspaceId] = useState('');
  const [larkAgentProfileId, setLarkAgentProfileId] = useState('');
  const [larkModelId, setLarkModelId] = useState('');
  const [larkAvailableModels, setLarkAvailableModels] = useState<Types.AcpAvailableModel[]>([]);

  // Sync routing configuration from backend plugin info
  useEffect(() => {
    const wx = plugins.find((p) => p.platform === 'weixin');
    if (wx) {
      setWxWorkspaceId(wx.workspace_id || '');
      setWxAgentProfileId(wx.agent_profile_id || '');
      setWxModelId(wx.model_id || '');
    }
    const lark = plugins.find((p) => p.platform === 'lark');
    if (lark) {
      setLarkWorkspaceId(lark.workspace_id || '');
      setLarkAgentProfileId(lark.agent_profile_id || '');
      setLarkModelId(lark.model_id || '');
    }
  }, [plugins]);

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

  // Load available models when agent profile changes
  const loadModelsForAgent = async (agentProfileId: string, workspaceId: string) => {
    if (!agentProfileId || !workspaceId) return [];
    try {
      const result = await commands.previewSessionConfig({
        workspace_id: workspaceId,
        agent_profile_id: agentProfileId,
      });
      return result.models?.available_models || [];
    } catch (err) {
      console.error('Failed to load models:', err);
      return [];
    }
  };

  // Load WeChat models when agent profile changes
  useEffect(() => {
    if (wxAgentProfileId && wxWorkspaceId) {
      loadModelsForAgent(wxAgentProfileId, wxWorkspaceId).then(setWxAvailableModels);
    } else {
      setWxAvailableModels([]);
    }
  }, [wxAgentProfileId, wxWorkspaceId]);

  // Load Lark models when agent profile changes
  useEffect(() => {
    if (larkAgentProfileId && larkWorkspaceId) {
      loadModelsForAgent(larkAgentProfileId, larkWorkspaceId).then(setLarkAvailableModels);
    } else {
      setLarkAvailableModels([]);
    }
  }, [larkAgentProfileId, larkWorkspaceId]);

  const handleUpdateWeixinConfig = async (wsId: string, agentId: string, modelId: string) => {
    setWxWorkspaceId(wsId);
    setWxAgentProfileId(agentId);
    setWxModelId(modelId);
    try {
      await commands.updateImPluginConfig('weixin', wsId || undefined, agentId || undefined, modelId || undefined);
      await refreshPlugins();
    } catch (err: any) {
      setError(err.message || 'Failed to update WeChat configuration');
    }
  };

  const handleUpdateLarkConfig = async (wsId: string, agentId: string, modelId: string) => {
    setLarkWorkspaceId(wsId);
    setLarkAgentProfileId(agentId);
    setLarkModelId(modelId);
    try {
      await commands.updateImPluginConfig('lark', wsId || undefined, agentId || undefined, modelId || undefined);
      await refreshPlugins();
    } catch (err: any) {
      setError(err.message || 'Failed to update Feishu configuration');
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
    let unlistenConfig: (() => void) | null = null;

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
            wxAgentProfileId || undefined,
            wxModelId || undefined
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

      unlistenConfig = await events.onImPluginConfigChanged(() => {
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
      if (unlistenConfig) unlistenConfig();
    };
  }, [wxBaseUrl, wxWorkspaceId, wxAgentProfileId, wxModelId]);

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
        wxAgentProfileId || undefined,
        wxModelId || undefined
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
        larkAgentProfileId || undefined,
        larkModelId || undefined
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
      {/* 二级 Tab: WebUI Access / Bot Channels */}
      <div className="flex gap-1 bg-snow rounded-interactive p-1 mb-3 w-fit">
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
            isBotChannelsActive
              ? 'bg-light-gray text-near-black'
              : 'bg-transparent text-stone hover:text-pure-black'
          }`}
        >
          Bot Channels
        </button>
      </div>

      {/* 三级 Tab: Bot 渠道图标 - 仅当 Bot Channels 选中时显示 */}
      {isBotChannelsActive && (
        <div className="flex gap-1 mb-5 w-fit ml-1">
          <button
            onClick={() => setSelectedTab('weixin')}
            className={`relative p-1.5 rounded-interactive transition-colors ${
              selectedTab === 'weixin'
                ? 'bg-light-gray/60'
                : 'bg-transparent hover:bg-snow'
            }`}
            title="WeChat Bot"
          >
            <img src="/logos/channels/weixin.svg" className="w-4 h-4" alt="WeChat" />
            {/* Connection status indicator */}
            {weixinPlugin?.status === 'connected' && (
              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-green" />
            )}
            {weixinPlugin?.status === 'connecting' && (
              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-yellow animate-pulse" />
            )}
            {weixinPlugin?.status === 'error' && (
              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-rose-500" />
            )}
            {/* Pairing request indicator */}
            {weixinPendingPairings.length > 0 && (
              <span className="absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-pure-black animate-pulse" />
            )}
          </button>
          <button
            onClick={() => setSelectedTab('lark')}
            className={`relative p-1.5 rounded-interactive transition-colors ${
              selectedTab === 'lark'
                ? 'bg-light-gray/60'
                : 'bg-transparent hover:bg-snow'
            }`}
            title="Feishu Bot"
          >
            <img src="/logos/channels/lark.svg" className="w-4 h-4" alt="Feishu" />
            {larkPendingPairings.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-pure-black animate-pulse" />
            )}
          </button>
        </div>
      )}

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
                {t("webui.enable")}
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
                    {webuiInfo.urls.map((url, index) => {
                      const isLocalhost = url.includes('127.0.0.1') || url.includes('localhost');
                      return (
                        <div key={url} className="flex items-center gap-2">
                          <span className="text-[12px] text-pure-black font-medium shrink-0">
                            {isLocalhost ? 'Local:' : 'LAN:'}
                          </span>
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
                      );
                    })}
                  </div>
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
                      {passwordVisible ? webuiPassword : '•'.repeat(webuiPassword.length)}
                    </code>
                    <button
                      onClick={() => setPasswordVisible(!passwordVisible)}
                      className="flex items-center justify-center p-1.5 rounded-interactive text-stone hover:bg-snow hover:text-pure-black bg-pure-white border border-light-gray transition-colors shrink-0"
                      title={passwordVisible ? 'Hide password' : 'Show password'}
                    >
                      {passwordVisible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
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
              <div className="border border-light-gray/60 rounded-container p-4 bg-pure-white">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-display font-medium text-[13px] text-pure-black">Configuration</span>
                    {weixinPlugin.status !== 'connected' && (
                      <span className={`text-[11px] ${
                        weixinPlugin.status === 'connecting' ? 'text-yellow' :
                        weixinPlugin.status === 'error' ? 'text-rose-500' :
                        'text-stone'
                      }`}>
                        {weixinPlugin.status === 'connecting' ? 'Connecting...' :
                         weixinPlugin.status === 'error' ? 'Error' :
                         'Disconnected'}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={handleStopWeixin}
                    disabled={loading}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-interactive text-[11px] font-medium transition-colors border border-rose-500 text-rose-500 hover:bg-rose-50 bg-pure-white"
                  >
                    <Square className="w-3 h-3" />
                    <span>Stop</span>
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
                    {t("wechat.scanLogin")}
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
                    {t("wechat.manualConfig")}
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

                        <div className="text-center">
                          <span className="text-[12px] font-medium text-pure-black">
                            {weixinScanStep === 'idle' && 'Initializing login bridge...'}
                            {weixinScanStep === 'qr' && t("wechat.scanInstruction")}
                            {weixinScanStep === 'scanned' && 'Scan detected! Please confirm login on your mobile WeChat app.'}
                            {weixinScanStep === 'done' && 'Login successful! Setting up bot channel...'}
                          </span>
                        </div>

                        <button
                          onClick={handleCancelWeixinLogin}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-interactive text-[11px] font-medium border border-light-gray text-stone hover:bg-snow hover:text-pure-black bg-pure-white"
                        >
                          <X className="w-3.5 h-3.5" />
                          <span>{t("wechat.cancelLogin")}</span>
                        </button>
                      </div>
                    ) : (
                      <div>
                        <button
                          onClick={handleStartWeixinLogin}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-interactive text-[11px] font-medium bg-pure-black text-pure-white border border-pure-black hover:bg-near-black"
                        >
                          <QrCode className="w-3.5 h-3.5" />
                          <span>{t("wechat.startScanLogin")}</span>
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
                          <span>{t("wechat.saveAndStart")}</span>
                        </button>
                      </div>
                    </form>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Session Routing Configuration */}
          <div className="border border-light-gray/60 rounded-container p-4 bg-pure-white space-y-4">
            <span className="font-display font-medium text-[13px] text-pure-black">Session Routing</span>
            <div className="grid grid-cols-3 gap-4">
              <SettingSelect
                value={wxWorkspaceId}
                onChange={(v) => handleUpdateWeixinConfig(v, wxAgentProfileId, wxModelId)}
                placeholder="Default Workspace (First Available)"
                label="Workspace"
                options={[
                  { value: '', label: 'Default Workspace (First Available)' },
                  ...workspaces.map((ws) => ({ value: ws.id, label: ws.display_name || ws.cwd })),
                ]}
              />
              <SettingSelect
                value={wxAgentProfileId}
                onChange={(v) => handleUpdateWeixinConfig(wxWorkspaceId, v, wxModelId)}
                placeholder="Default Agent (First Enabled)"
                label="Agent Profile"
                options={[
                  { value: '', label: 'Default Agent (First Enabled)' },
                  ...agents.map((a) => ({ value: a.id, label: a.name })),
                ]}
              />
              <SettingSelectWithSearch
                value={wxModelId}
                onChange={(v) => handleUpdateWeixinConfig(wxWorkspaceId, wxAgentProfileId, v)}
                placeholder="Default Model (Agent Default)"
                label="Model"
                searchPlaceholder="Search models..."
                options={[
                  { value: '', label: 'Default Model (Agent Default)' },
                  ...wxAvailableModels.map((m) => ({ value: m.id ?? m.model_id ?? '', label: m.name ?? m.id ?? '' })),
                ]}
              />
            </div>
          </div>

          {/* Pairing Requests Section - 仅当有待处理请求时显示 */}
          {weixinPendingPairings.length > 0 && (
            <div className="border border-light-gray/60 rounded-container p-4 bg-pure-white space-y-4 mt-4">
              <div className="flex flex-col gap-1">
                <span className="font-display font-medium text-[13px] text-pure-black">Pairing Requests</span>
                <span className="text-[11px] text-stone">
                  Users from WeChat requesting authorization to use this bot.
                </span>
              </div>

              {/* 手动输入区 */}
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

              {/* 消息反馈 */}
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

              {/* 待处理列表 */}
              <div className="space-y-3 border-t border-light-gray/40 pt-3">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] text-silver font-medium uppercase tracking-wider">
                    Pending Requests ({weixinPendingPairings.length})
                  </div>
                  <button
                    onClick={() => clearChannelPairings('weixin')}
                    className="text-[10px] text-stone hover:text-pure-black"
                  >
                    Clear
                  </button>
                </div>

                <div className="divide-y divide-light-gray/30">
                  {weixinPendingPairings.map((req) => (
                    <div key={req.code} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-display font-medium text-[12px] text-pure-black">
                          {req.display_name} ({req.platform_user_id})
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
              </div>
            </div>
          )}
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
              <span className="text-[11px] text-stone">Specify which Workspace, Agent Profile, and Model will handle incoming Feishu messages on this channel.</span>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <SettingSelect
                value={larkWorkspaceId}
                onChange={(v) => handleUpdateLarkConfig(v, larkAgentProfileId, larkModelId)}
                placeholder="Default Workspace (First Available)"
                label="Workspace"
                options={[
                  { value: '', label: 'Default Workspace (First Available)' },
                  ...workspaces.map((ws) => ({ value: ws.id, label: ws.display_name || ws.cwd })),
                ]}
              />
              <SettingSelect
                value={larkAgentProfileId}
                onChange={(v) => handleUpdateLarkConfig(larkWorkspaceId, v, larkModelId)}
                placeholder="Default Agent (First Enabled)"
                label="Agent Profile"
                options={[
                  { value: '', label: 'Default Agent (First Enabled)' },
                  ...agents.map((a) => ({ value: a.id, label: a.name })),
                ]}
              />
              <SettingSelectWithSearch
                value={larkModelId}
                onChange={(v) => handleUpdateLarkConfig(larkWorkspaceId, larkAgentProfileId, v)}
                placeholder="Default Model (Agent Default)"
                label="Model"
                searchPlaceholder="Search models..."
                options={[
                  { value: '', label: 'Default Model (Agent Default)' },
                  ...larkAvailableModels.map((m) => ({ value: m.id ?? m.model_id ?? '', label: m.name ?? m.id ?? '' })),
                ]}
              />
            </div>
          </div>

          {/* Pairing Requests Section - 仅当有待处理请求时显示 */}
          {larkPendingPairings.length > 0 && (
            <div className="border border-light-gray/60 rounded-container p-4 bg-pure-white space-y-4 mt-4">
              <div className="flex flex-col gap-1">
                <span className="font-display font-medium text-[13px] text-pure-black">Pairing Requests</span>
                <span className="text-[11px] text-stone">
                  Users from Feishu requesting authorization to use this bot.
                </span>
              </div>

              {/* 手动输入区 */}
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

              {/* 消息反馈 */}
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

              {/* 待处理列表 */}
              <div className="space-y-3 border-t border-light-gray/40 pt-3">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] text-silver font-medium uppercase tracking-wider">
                    Pending Requests ({larkPendingPairings.length})
                  </div>
                  <button
                    onClick={() => clearChannelPairings('lark')}
                    className="text-[10px] text-stone hover:text-pure-black"
                  >
                    Clear
                  </button>
                </div>

                <div className="divide-y divide-light-gray/30">
                  {larkPendingPairings.map((req) => (
                    <div key={req.code} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-display font-medium text-[12px] text-pure-black">
                          {req.display_name} ({req.platform_user_id})
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
              </div>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
