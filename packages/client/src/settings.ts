/** 客户端设置：localStorage 持久化 */
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
  deepseekModel: 'deepseek-chat',
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
  return `ws://${s.serverHost}:${s.serverPort}`;
}
