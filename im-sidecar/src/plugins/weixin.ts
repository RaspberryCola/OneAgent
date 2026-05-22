import { BasePlugin, IncomingMessage, OutgoingMessage, PluginStatus } from './base.js';
import QRCode from 'qrcode';
import crypto from 'crypto';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = '3';
const REQUEST_TIMEOUT_MS = 15_000;
const POLL_TIMEOUT_MS = 35_000;
const MAX_QR_RETRIES = 3;
const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const TEXT_ITEM_TYPE = 1;

interface PendingResponse {
  resolve: (response: { text?: string }) => void;
  reject: (error: Error) => void;
  draftText: string;
  hasDraft: boolean;
  sentTextNow: boolean;
  lastSentText?: string;
  sendTextNow?: (text: string) => Promise<void>;
  sendQueue: Promise<void>;
  sendError?: Error;
  timer: NodeJS.Timeout;
}

export class WeixinPlugin extends BasePlugin {
  readonly platform = 'weixin';

  private accountId = '';
  private botToken = '';
  private baseUrl = DEFAULT_BASE_URL;
  private abortController: AbortController | null = null;
  private loginAbortController: AbortController | null = null;
  private pendingResponses = new Map<string, PendingResponse>();

  async start(config: any): Promise<void> {
    const { accountId, botToken, baseUrl } = config || {};
    if (!accountId || !botToken) {
      // Allow starting without credentials for login mode
      this.setStatus('disconnected');
      return;
    }

    this.accountId = accountId;
    this.botToken = botToken;
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;

    this.setStatus('connecting');
    this.abortController = new AbortController();

    this.startMonitorLoop(this.abortController.signal);
    this.setStatus('connected');
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;

    this.loginAbortController?.abort();
    this.loginAbortController = null;

    for (const [chatId, pending] of this.pendingResponses.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Plugin stopped'));
      this.pendingResponses.delete(chatId);
    }

    this.setStatus('disconnected');
  }

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<string> {
    const pending = this.pendingResponses.get(chatId);
    if (pending && message.text !== undefined) {
      this.flushDraft(pending);
      this.updateDraft(pending, message.text);
    }

    if (pending && !message.is_streaming_update) {
      this.flushDraft(pending);
      await pending.sendQueue;
      clearTimeout(pending.timer);
      this.pendingResponses.delete(chatId);
      pending.resolve({
        text: pending.sentTextNow ? undefined : pending.draftText || undefined,
      });
    }

    return `weixin_pending_${chatId}`;
  }

  async editMessage(chatId: string, _msgId: string, message: OutgoingMessage): Promise<void> {
    const pending = this.pendingResponses.get(chatId);
    if (!pending) return;

    if (message.text !== undefined) {
      this.updateDraft(pending, message.text);
    }

    if (!message.is_streaming_update) {
      this.flushDraft(pending);
      await pending.sendQueue;
      clearTimeout(pending.timer);
      this.pendingResponses.delete(chatId);
      if (pending.sendError) {
        pending.reject(pending.sendError);
        return;
      }
      pending.resolve({
        text: pending.sentTextNow ? undefined : pending.draftText || undefined,
      });
    }
  }

  // ==================== WeChat Login Flow ====================

  async startLogin(): Promise<void> {
    this.loginAbortController?.abort();
    this.loginAbortController = new AbortController();

    const signal = this.loginAbortController.signal;

    try {
      let qrRetries = 0;
      while (qrRetries < MAX_QR_RETRIES) {
        if (signal.aborted) return;

        // 1. Fetch QR ticket from WeChat iLink
        const qrResult = await this.httpGet<{ qrcode: string; qrcode_img_content: string }>(
          `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
          signal
        );

        if (!qrResult.qrcode) {
          throw new Error('Invalid QR code response');
        }

        // 2. Generate Base64 Data URL using qrcode library
        const qrDataUrl = await QRCode.toDataURL(qrResult.qrcode);

        // 3. Emit QR event
        this.emitNotification('weixin_login_qr', { qr_url: qrDataUrl });

        // 4. Poll status
        const pollResult = await this.pollQRStatus(qrResult.qrcode, signal);

        if (pollResult === 'expired') {
          qrRetries++;
          continue;
        }
        if (pollResult === 'aborted') return;

        // Confirmed! Emit done event
        this.emitNotification('weixin_login_done', {
          account_id: pollResult.accountId,
          bot_token: pollResult.botToken,
        });
        return;
      }

      this.emitError('QR code expired too many times');
    } catch (err: any) {
      if (!signal.aborted) {
        this.emitError(err.message || 'Login flow error');
      }
    }
  }

  async stopLogin(): Promise<void> {
    this.loginAbortController?.abort();
    this.loginAbortController = null;
  }

  private async pollQRStatus(qrcode: string, signal: AbortSignal): Promise<'expired' | 'aborted' | { accountId: string; botToken: string }> {
    while (!signal.aborted) {
      let result: {
        status: 'wait' | 'scaned' | 'expired' | 'confirmed';
        bot_token?: string;
        baseurl?: string;
        ilink_bot_id?: string;
      };
      try {
        result = await this.httpGet<{
          status: 'wait' | 'scaned' | 'expired' | 'confirmed';
          bot_token?: string;
          baseurl?: string;
          ilink_bot_id?: string;
        }>(
          `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
          signal,
          POLL_TIMEOUT_MS
        );
      } catch (error: any) {
        if (error.message && error.message.includes('Timeout')) {
          continue;
        }
        throw error;
      }

      switch (result.status) {
        case 'wait':
          break;
        case 'scaned':
          this.emitNotification('weixin_login_scanned', {});
          break;
        case 'expired':
          return 'expired';
        case 'confirmed':
          if (!result.bot_token || !result.ilink_bot_id) {
            throw new Error('Missing bot_token or ilink_bot_id in confirmed response');
          }
          return {
            accountId: result.ilink_bot_id,
            botToken: result.bot_token,
          };
      }
    }
    return 'aborted';
  }

  // ==================== Monitor Loop ====================

  private async startMonitorLoop(signal: AbortSignal) {
    let buf = '';
    let consecutiveFailures = 0;
    const wechatUin = crypto.randomBytes(4).toString('base64');

    while (!signal.aborted) {
      try {
        const resp = await this.apiPost<any>(
          'ilink/bot/getupdates',
          { get_updates_buf: buf, base_info: {} },
          wechatUin,
          LONG_POLL_TIMEOUT_MS,
          signal
        );

        const isApiError =
          (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);

        if (isApiError) {
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            consecutiveFailures = 0;
            await this.sleep(BACKOFF_DELAY_MS, signal);
          } else {
            await this.sleep(RETRY_DELAY_MS, signal);
          }
          continue;
        }

        consecutiveFailures = 0;

        if (resp.get_updates_buf) {
          buf = resp.get_updates_buf;
        }

        for (const msg of resp.msgs ?? []) {
          const items = msg.item_list ?? [];
          const textItem = items.find((i: any) => i.type === TEXT_ITEM_TYPE);
          if (!textItem) continue;

          const conversationId = msg.from_user_id ?? '';
          const text = textItem.text_item?.text?.trim() || '';
          const msgId = msg.msg_id ?? String(Date.now());

          if (!text) continue;

          // Process chat request and wait for reply
          try {
            await this.handleIncomingChat(conversationId, text, msgId, msg.context_token);
          } catch (chatErr) {
            // Log/ignore chat processing error
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await this.sleep(BACKOFF_DELAY_MS, signal);
        } else {
          await this.sleep(RETRY_DELAY_MS, signal);
        }
      }
    }
  }

  private handleIncomingChat(conversationId: string, text: string, msgId: string, contextToken?: string): Promise<void> {
    const existing = this.pendingResponses.get(conversationId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.reject(new Error('superseded'));
      this.pendingResponses.delete(conversationId);
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(conversationId);
        reject(new Error('Response timeout'));
      }, 5 * 60 * 1000); // 5 min timeout

      const sendTextNow = async (outgoingText: string) => {
        await this.apiPost(
          'ilink/bot/sendmessage',
          {
            msg: {
              to_user_id: conversationId,
              client_id: crypto.randomUUID(),
              message_type: 2,
              message_state: 2,
              item_list: [{ type: TEXT_ITEM_TYPE, text_item: { text: outgoingText } }],
              context_token: contextToken,
            },
            base_info: {},
          },
          crypto.randomBytes(4).toString('base64'),
          API_TIMEOUT_MS
        );
      };

      this.pendingResponses.set(conversationId, {
        resolve: () => resolve(),
        reject,
        draftText: '',
        hasDraft: false,
        sentTextNow: false,
        sendTextNow,
        sendQueue: Promise.resolve(),
        timer,
      });

      // Emit incoming message event to Rust
      const incoming: IncomingMessage = {
        id: msgId,
        platform: 'weixin',
        chat_id: conversationId,
        user_id: conversationId,
        user_name: 'WeChat User',
        content: { type: 'Text', value: text },
        timestamp: Date.now(),
      };

      this.emitIncomingMessage(incoming);
    });
  }

  private updateDraft(pending: PendingResponse, text: string): void {
    const plainText = text.replace(/<[^>]*>/g, ''); // Strip simple HTML
    const trimmed = plainText.trim();
    if (!trimmed || trimmed === '⏳ Thinking...') {
      pending.draftText = '';
      pending.hasDraft = false;
      return;
    }
    if (pending.sentTextNow && plainText === pending.lastSentText) {
      pending.draftText = '';
      pending.hasDraft = false;
      return;
    }

    pending.draftText = plainText;
    pending.hasDraft = pending.draftText.trim().length > 0;
  }

  private flushDraft(pending: PendingResponse): void {
    if (!pending.hasDraft) return;

    const text = pending.draftText;
    pending.hasDraft = false;

    if (!pending.sendTextNow) return;

    const sendTextNow = pending.sendTextNow;
    pending.sentTextNow = true;
    pending.lastSentText = text;
    pending.draftText = '';
    pending.sendQueue = pending.sendQueue
      .then(() => sendTextNow(text))
      .catch((error) => {
        pending.sendError = error;
      });
  }

  // ==================== HTTP Utilities ====================

  private async httpGet<T>(pathWithQuery: string, signal: AbortSignal, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<T> {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`;
    const url = new URL(pathWithQuery, base).toString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'iLink-App-ClientVersion': '1',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json() as T;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async apiPost<T>(
    endpoint: string,
    bodyObj: unknown,
    wechatUin: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`;
    const url = new URL(endpoint, base).toString();
    const body = JSON.stringify(bodyObj);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          AuthorizationType: 'ilink_bot_token',
          Authorization: `Bearer ${this.botToken}`,
          'X-WECHAT-UIN': wechatUin,
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json() as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }
}
