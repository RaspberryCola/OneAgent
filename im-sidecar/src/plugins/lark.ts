import { BasePlugin, IncomingMessage, OutgoingMessage, ActionButton } from './base.js';
import * as lark from '@larksuiteoapi/node-sdk';

const EVENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const EVENT_CACHE_CLEANUP_INTERVAL = 60 * 1000; // 1 minute

export class LarkPlugin extends BasePlugin {
  readonly platform = 'lark';

  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private eventDispatcher: lark.EventDispatcher | null = null;
  private processedEvents = new Map<string, number>();
  private eventCleanupTimer: NodeJS.Timeout | null = null;

  async start(config: any): Promise<void> {
    const { appId, appSecret, encryptKey, verificationToken, domain } = config || {};
    if (!appId || !appSecret) {
      throw new Error('Lark App ID and App Secret are required');
    }

    this.setStatus('connecting');

    const larkDomain = domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

    // 1. Initialize client
    this.client = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild,
      domain: larkDomain,
    });

    // 2. Initialize EventDispatcher
    this.eventDispatcher = new lark.EventDispatcher({
      encryptKey: encryptKey || '',
      verificationToken: verificationToken || '',
    });

    this.setupEventHandlers();

    // 3. Initialize WebSocket client
    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain: larkDomain,
      loggerLevel: lark.LoggerLevel.info,
    });

    // 4. Start WSClient
    this.wsClient
      .start({
        eventDispatcher: this.eventDispatcher,
      })
      .then(() => {
        this.setStatus('connected');
      })
      .catch((err: any) => {
        this.setStatus('error');
        this.emitError(err.message || 'Failed to start Lark WebSocket client');
      });

    // 5. Start periodic cleanup of processed events
    this.startEventCleanup();
  }

  async stop(): Promise<void> {
    this.stopEventCleanup();

    if (this.wsClient) {
      try {
        (this.wsClient as any).close();
      } catch (err) {
        // Ignore
      }
      this.wsClient = null;
    }

    this.client = null;
    this.eventDispatcher = null;
    this.processedEvents.clear();
    this.setStatus('disconnected');
  }

  private getReceiveIdType(chatId: string): 'open_id' | 'chat_id' | 'union_id' | 'user_id' {
    if (chatId.startsWith('ou_')) return 'open_id';
    if (chatId.startsWith('oc_')) return 'chat_id';
    if (chatId.startsWith('on_')) return 'union_id';
    return 'user_id';
  }

  private buildInteractiveCard(text: string, buttons?: ActionButton[] | null): Record<string, any> {
    const formattedText = this.formatContentText(text);
    const elements: Array<Record<string, any>> = [];

    if (formattedText) {
      elements.push({
        tag: 'markdown',
        content: formattedText,
      });
    }

    if (buttons && buttons.length > 0) {
      const actions = buttons.map((btn) => ({
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: btn.label,
        },
        type: 'primary',
        value: {
          action: btn.id,
        },
      }));

      elements.push({
        tag: 'action',
        actions,
      });
    }

    return {
      config: {
        wide_screen_mode: true,
      },
      elements,
    };
  }

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<string> {
    if (!this.client) {
      throw new Error('Lark client is not initialized');
    }

    const receiveIdType = this.getReceiveIdType(chatId);
    const card = this.buildInteractiveCard(message.text, message.buttons);

    const response = await this.client.im.message.create({
      params: {
        receive_id_type: receiveIdType,
      },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });

    if (!response.data?.message_id) {
      throw new Error('Lark API did not return a message_id');
    }

    return response.data.message_id;
  }

  async editMessage(chatId: string, msgId: string, message: OutgoingMessage): Promise<void> {
    if (!this.client) {
      throw new Error('Lark client is not initialized');
    }

    const card = this.buildInteractiveCard(message.text, message.buttons);

    try {
      await this.client.im.message.patch({
        path: {
          message_id: msgId,
        },
        data: {
          content: JSON.stringify(card),
        },
      });
    } catch (error: any) {
      const errorCode = error?.response?.data?.code || error?.code;
      const errorMsg = error?.response?.data?.msg || error?.message || '';

      // Ignore "message not changed" or "not modified" errors
      if (errorCode === 230002 || errorMsg.includes('not modified')) {
        return;
      }

      throw error;
    }
  }

  private setupEventHandlers(): void {
    if (!this.eventDispatcher) return;

    this.eventDispatcher.register({
      'im.message.receive_v1': async (data: any) => {
        const message = data?.message;
        const sender = data?.sender;

        if (!message || !sender) return {};

        const eventId = message.message_id;
        if (eventId && this.isEventProcessed(eventId)) {
          return {};
        }
        if (eventId) {
          this.markEventProcessed(eventId);
        }

        const userId = sender.sender_id?.user_id || sender.sender_id?.open_id;
        if (!userId) return {};

        let text = '';
        try {
          const content = JSON.parse(message.content || '{}');
          text = content.text || '';
        } catch (e) {
          text = message.content || '';
        }

        const incoming: IncomingMessage = {
          id: message.message_id || Date.now().toString(),
          platform: 'lark',
          chat_id: message.chat_id || userId,
          user_id: userId,
          user_name: 'Feishu User',
          content: {
            type: text.startsWith('/') ? 'Command' : 'Text',
            value: text.startsWith('/') ? text.slice(1) : text,
          },
          timestamp: message.create_time ? parseInt(message.create_time, 10) : Date.now(),
        };

        this.emitIncomingMessage(incoming);
        return {};
      },

      'card.action.trigger': async (data: any) => {
        const action = data?.action;
        const operator = data?.operator;
        const eventToken = data?.token;

        if (!action || !operator) return {};

        if (eventToken && this.isEventProcessed(eventToken)) {
          return {};
        }
        if (eventToken) {
          this.markEventProcessed(eventToken);
        }

        const userId = operator.user_id || operator.open_id;
        if (!userId) return {};

        const actionValue = action.value?.action || '';
        if (!actionValue) return {};

        const chatId = data?.open_chat_id || userId;

        const incoming: IncomingMessage = {
          id: eventToken || Date.now().toString(),
          platform: 'lark',
          chat_id: chatId,
          user_id: userId,
          user_name: 'Feishu User',
          content: {
            type: 'Action',
            value: actionValue,
          },
          timestamp: Date.now(),
        };

        this.emitIncomingMessage(incoming);
        return {};
      },
    });
  }

  private formatContentText(text: string): string {
    // Replace basic HTML formatting to Markdown
    let result = text
      .replace(/<b>(.*?)<\/b>/gi, '**$1**')
      .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
      .replace(/<i>(.*?)<\/i>/gi, '*$1*')
      .replace(/<em>(.*?)<\/em>/gi, '*$1*')
      .replace(/<code>(.*?)<\/code>/gi, '`$1`');

    // Strip any other HTML tags
    result = result.replace(/<[^>]*>/g, '');
    return result;
  }

  private isEventProcessed(eventId: string): boolean {
    return this.processedEvents.has(eventId);
  }

  private markEventProcessed(eventId: string): void {
    this.processedEvents.set(eventId, Date.now());
  }

  private startEventCleanup(): void {
    if (this.eventCleanupTimer) return;
    this.eventCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [eventId, timestamp] of this.processedEvents.entries()) {
        if (now - timestamp > EVENT_CACHE_TTL) {
          this.processedEvents.delete(eventId);
        }
      }
    }, EVENT_CACHE_CLEANUP_INTERVAL);
  }

  private stopEventCleanup(): void {
    if (this.eventCleanupTimer) {
      clearInterval(this.eventCleanupTimer);
      this.eventCleanupTimer = null;
    }
  }
}
