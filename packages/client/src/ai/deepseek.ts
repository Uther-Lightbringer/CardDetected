import { CARDS, type GameAction, type GameView } from '@cardetect/shared';

/**
 * Deepseek 大模型 AI 对手。
 * 把当前局面以文本形式发给模型，要求返回 JSON 动作序列；
 * 动作在本地由规则引擎逐一校验，非法动作会被跳过（调用方负责兜底）。
 */

const SYSTEM_PROMPT = `你是一名卡牌对战游戏的高手，正在对局中轮到你行动。
游戏规则：回合制 1v1，把对手血量打到 0 获胜。每回合法力上限+1并回满，用费出牌。
战场每方有前排(front)和后排(back)各3格(序号0-2)。近战单位只能攻击敌方前排，敌方前排为空才能攻击后排或玩家("player")；
带 ranged 的远程单位可攻击任意目标；带 guard 的单位必须被优先攻击；单位打出当回合不能攻击（charge 除外）。
请根据局面输出你的完整回合动作序列，只输出 JSON，格式：
{"actions":[
  {"type":"play_card","handIndex":0,"row":"front","slot":0},
  {"type":"play_card","handIndex":1,"row":"front","slot":0,"target":{"row":"front","slot":0}},
  {"type":"attack","attacker":{"row":"front","slot":0},"target":"player"},
  {"type":"end_turn"}
]}
注意：play_card 的 handIndex 是打出那一刻的手牌下标（每打出一张后续手牌下标前移）；
法术"审讯"需要 target（敌方单位）；最后必须有 end_turn。不要输出任何解释。`;

function describeView(view: GameView): string {
  const hand = view.me.hand
    .map((id, i) => {
      const c = CARDS[id];
      const stat = c.kind === 'unit' ? `${c.atk}/${c.hp}` : '';
      const kw = c.keywords?.length ? ` 关键词:${c.keywords.join(',')}` : '';
      return `  [${i}] ${c.name} ${c.cost}费 ${stat}${kw} - ${c.desc}`;
    })
    .join('\n');
  const board = (b: GameView['me']['board'], label: string): string => {
    const cell = (u: GameView['me']['board']['front'][number]): string =>
      u ? `${u.name}(${u.atk}/${u.hp}${u.sick ? ',休整中' : ''}${u.attacked ? ',已攻击' : ''})` : '空';
    return `  ${label}前排: [0]${cell(b.front[0])} [1]${cell(b.front[1])} [2]${cell(b.front[2])}\n  ${label}后排: [0]${cell(b.back[0])} [1]${cell(b.back[1])} [2]${cell(b.back[2])}`;
  };
  return `当前第 ${view.turn} 回合，轮到你行动。
你的状态: 血量${view.me.hp}/${view.me.maxHp} 法力${view.me.mana}/${view.me.maxMana} 牌库${view.me.deckCount}张
对手状态: 血量${view.opp.hp} 手牌${view.opp.handCount}张 牌库${view.opp.deckCount}张
你的手牌:\n${hand || '  (无)'}
${board(view.me.board, '你的')}
${board(view.opp.board, '对手的')}
请输出你的动作序列 JSON。`;
}

/** 从模型输出中提取 JSON 动作数组 */
export function parseActions(text: string): GameAction[] | null {
  try {
    const cleaned = text.replace(/```(?:json)?/g, '').trim();
    const start = cleaned.search(/[[{]/);
    if (start === -1) return null;
    const parsed = JSON.parse(cleaned.slice(start)) as { actions?: GameAction[] } | GameAction[];
    const actions = Array.isArray(parsed) ? parsed : parsed.actions;
    if (!Array.isArray(actions)) return null;
    return actions.filter((a) => a && typeof a === 'object' && 'type' in a);
  } catch {
    // 尝试截取到最后一个完整 JSON 对象
    try {
      const m = text.match(/\{[\s\S]*"actions"[\s\S]*\]/);
      if (!m) return null;
      const parsed = JSON.parse(`${m[0]}}`) as { actions: GameAction[] };
      return parsed.actions;
    } catch {
      return null;
    }
  }
}

export async function requestDeepseekActions(
  apiKey: string,
  model: string,
  view: GameView,
  timeoutMs = 20000,
): Promise<GameAction[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: describeView(view) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Deepseek API 错误: ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? '';
    const actions = parseActions(content);
    if (!actions || actions.length === 0) throw new Error('大模型返回无法解析');
    return actions;
  } finally {
    clearTimeout(timer);
  }
}
