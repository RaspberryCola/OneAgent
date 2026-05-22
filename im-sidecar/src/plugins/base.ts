export type MessageContent =
  | { type: 'Text'; value: string }
  | { type: 'Command'; value: string }
  | { type: 'Action'; value: string };

export interface IncomingMessage {
  id: string;
  platform: string;
  chat_id: string;
  user_id: string;
  user_name: string;
  content: MessageContent;
  timestamp: number;
}

export interface ActionButton {
  id: string;
  label: string;
}

export interface OutgoingMessage {
  text: string;
  buttons?: ActionButton[] | null;
  is_streaming_update: boolean;
}

export type PluginStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export abstract class BasePlugin {
  abstract readonly platform: string;
  protected status: PluginStatus = 'disconnected';

  constructor(
    protected emitIncomingMessage: (msg: IncomingMessage) => void,
    protected emitStatusChanged: (status: PluginStatus) => void,
    protected emitError: (err: string) => void,
    protected emitNotification: (method: string, params: any) => void
  ) {}

  abstract start(config: any): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendMessage(chatId: string, message: OutgoingMessage): Promise<string>;
  abstract editMessage(chatId: string, msgId: string, message: OutgoingMessage): Promise<void>;

  getStatus(): PluginStatus {
    return this.status;
  }

  protected setStatus(status: PluginStatus) {
    this.status = status;
    this.emitStatusChanged(status);
  }
}
