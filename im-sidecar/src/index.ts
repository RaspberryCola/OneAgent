import readline from 'readline';
import { BasePlugin, IncomingMessage, PluginStatus } from './plugins/base.js';
import { LarkPlugin } from './plugins/lark.js';

let activePlugin: BasePlugin | null = null;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const request = JSON.parse(trimmed);
    if (request.jsonrpc !== '2.0') {
      return;
    }

    const { id, method, params } = request;
    
    // Process JSON-RPC request
    try {
      const result = await handleRpcRequest(method, params);
      if (id !== undefined && id !== null) {
        console.log(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result,
        }));
      }
    } catch (err: any) {
      if (id !== undefined && id !== null) {
        console.log(JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: {
            code: err.code || -32603,
            message: err.message || 'Internal error',
          },
        }));
      }
    }
  } catch (err) {
    // Ignore invalid JSON on stdin
  }
});

function sendNotification(method: string, params: any) {
  console.log(JSON.stringify({
    jsonrpc: '2.0',
    method,
    params,
  }));
}

const emitIncomingMessage = (msg: IncomingMessage) => sendNotification('incoming_message', msg);
const emitStatusChanged = (status: PluginStatus) => sendNotification('plugin_status_changed', { status });
const emitError = (error: string) => sendNotification('plugin_error', { error });

async function handleRpcRequest(method: string, params: any): Promise<any> {
  switch (method) {
    case 'plugin.start': {
      const { plugin_type, config } = params;
      if (activePlugin) {
        await activePlugin.stop();
        activePlugin = null;
      }

      if (plugin_type === 'lark') {
        activePlugin = new LarkPlugin(emitIncomingMessage, emitStatusChanged, emitError, sendNotification);
      } else {
        throw new Error(`Unsupported plugin type: ${plugin_type}`);
      }

      await activePlugin.start(config);
      return null;
    }

    case 'plugin.stop': {
      if (activePlugin) {
        await activePlugin.stop();
        activePlugin = null;
      }
      return null;
    }

    case 'plugin.send_message': {
      const { chat_id, message } = params;
      if (!activePlugin) {
        throw new Error('No active plugin');
      }
      return await activePlugin.sendMessage(chat_id, message);
    }

    case 'plugin.edit_message': {
      const { chat_id, msg_id, message } = params;
      if (!activePlugin) {
        throw new Error('No active plugin');
      }
      await activePlugin.editMessage(chat_id, msg_id, message);
      return null;
    }

    case 'plugin.status': {
      if (!activePlugin) {
        return { status: 'disconnected' };
      }
      return { status: activePlugin.getStatus() };
    }

    default:
      const err = new Error(`Method not found: ${method}`);
      (err as any).code = -32601;
      throw err;
  }
}