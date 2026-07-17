import type { ClientMessage, ServerMessage } from '@cardetect/shared';

type Listener = (msg: ServerMessage) => void;

/** WebSocket 客户端封装：按消息类型分发 */
export class WsClient {
  private ws: WebSocket;
  private listeners = new Map<string, Set<Listener>>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      this.listeners.get(msg.type)?.forEach((cb) => cb(msg));
      this.listeners.get('*')?.forEach((cb) => cb(msg));
    };
  }

  /** 连接服务器，超时或失败会 reject */
  static connect(url: string, timeoutMs = 4000): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.close();
          reject(new Error('连接超时'));
        }
      }, timeoutMs);
      ws.onopen = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(new WsClient(ws));
        }
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('无法连接到服务器'));
        }
      };
    });
  }

  on<T extends ServerMessage['type']>(type: T, cb: (msg: Extract<ServerMessage, { type: T }>) => void): () => void {
    const l = cb as Listener;
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(l);
    return () => this.listeners.get(type)?.delete(l);
  }

  send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  onClose(cb: () => void): void {
    this.ws.onclose = cb;
  }

  close(): void {
    this.ws.onclose = null;
    this.ws.close();
  }
}
