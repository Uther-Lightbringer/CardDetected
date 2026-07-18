import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * AI 代理配置与调用。
 * 设计要点：配置只存服务端（data/ai-config.json，管理面板可改），客户端只调 /api/ai/chat
 * 传标准 messages，完全不感知具体厂商；以后新增模型厂商只需在本文件加一个适配分支。
 */

/** 与厂商无关的聊天消息（/api/ai/chat 的请求格式） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiConfig {
  provider: 'deepseek';
  apiKey: string;
  model: string;
  baseUrl: string;
  enabled: boolean;
}

const DEFAULT_CONFIG: AiConfig = {
  provider: 'deepseek',
  apiKey: '',
  model: 'deepseek-v4-flash',
  baseUrl: 'https://api.deepseek.com',
  enabled: true,
};

export class AiConfigStore {
  private cfg: AiConfig;

  constructor(private readonly file: string) {
    // 初始值可用环境变量播种（Docker 部署注入 key）；配置文件存在后以文件为准
    this.cfg = { ...DEFAULT_CONFIG, apiKey: process.env.DEEPSEEK_API_KEY ?? '' };
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<AiConfig>;
        this.cfg = { ...this.cfg, ...raw, provider: 'deepseek' };
      } catch {
        console.warn(`[ai-config] ${file} 损坏，已用默认配置`);
      }
    }
  }

  get(): AiConfig {
    return { ...this.cfg };
  }

  /** 管理面板展示用：key 脱敏，绝不回传完整值 */
  view(): Omit<AiConfig, 'apiKey'> & { hasKey: boolean; keyPreview: string | null } {
    const { apiKey, ...rest } = this.cfg;
    return {
      ...rest,
      hasKey: apiKey.length > 0,
      keyPreview: apiKey ? `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}` : null,
    };
  }

  /** 更新配置；apiKey 字段缺席表示保持原值（面板留空不改），显式传空串则清除 */
  update(patch: Partial<AiConfig>): void {
    this.cfg = { ...this.cfg, ...patch, provider: 'deepseek' };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.cfg, null, 2));
  }
}

/** 调用已配置的模型厂商，返回文本内容 */
export async function chatCompletion(
  cfg: AiConfig,
  messages: ChatMessage[],
  opts: { responseFormat?: 'json' | 'text'; temperature?: number; timeoutMs?: number; maxTokens?: number } = {},
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    // deepseek（OpenAI 兼容协议）
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 2048,
        // V4 模型默认开启思考模式：游戏决策/测试场景不需要，关闭以省 token、降延迟
        thinking: { type: 'disabled' },
        ...(opts.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
        messages,
      }),
    });
    if (!res.ok) throw new Error(`${cfg.provider} API 错误: ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`${cfg.provider} 返回为空`);
    return content;
  } finally {
    clearTimeout(timer);
  }
}
