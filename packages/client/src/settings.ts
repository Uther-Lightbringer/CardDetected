/** 客户端设置：localStorage 持久化 */

/**
 * 云部署模式（构建时注入 VITE_CLOUD=1）：
 * 隐藏设置页；多人服务器走同源 nginx 反代（/ws）；单人 AI 走服务端代理（/api/ai/chat），无需任何配置
 */
export const CLOUD_MODE = import.meta.env.VITE_CLOUD === '1';

export interface Settings {
  /** 多人游戏服务器 */
  serverHost: string;
  serverPort: number;
  /** 单人游戏 AI 对手 */
  aiProvider: 'builtin' | 'deepseek';
  deepseekKey: string;
  deepseekModel: string;
}

const KEY = 'cardetect_settings';

export const DEFAULT_SETTINGS: Settings = {
  serverHost: '127.0.0.1',
  serverPort: 9000,
  aiProvider: 'builtin',
  deepseekKey: '',
  deepseekModel: 'deepseek-v4-flash',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function serverUrl(s: Settings): string {
  if (CLOUD_MODE) {
    // 同源反代：nginx 把 /ws 转发到游戏服务器
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }
  return `ws://${s.serverHost}:${s.serverPort}`;
}
