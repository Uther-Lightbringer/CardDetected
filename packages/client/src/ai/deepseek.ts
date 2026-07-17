import {
  CARDS,
  KEYWORD_DEFS,
  legalTargets,
  type GameAction,
  type GameState,
  type Keyword,
  type PlayerIndex,
  type Row,
  type TargetRef,
  type UnitRef,
  type UnitState,
} from '@cardetect/shared';

/**
 * Deepseek 大模型 AI 对手。
 * 设计要点：
 * - 把引擎算好的「合法攻击目标」「费用是否足够」直接写进 prompt，模型只做选择题
 * - 出牌用卡牌名而不是 handIndex，规避模型数错下标的问题
 * - response_format: json_object 强制合法 JSON
 * - 附带最近战况（短期记忆）与一句侦探风台词（comment）
 */

// ==================== 模型动作协议（与引擎 GameAction 解耦） ====================

export type AiAction =
  | { type: 'play_card'; card?: string; handIndex?: number; row?: Row; slot?: number; target?: TargetRef }
  | { type: 'attack'; attacker: UnitRef; target: TargetRef }
  | { type: 'end_turn' };

export interface AiTurn {
  actions: AiAction[];
  comment?: string;
}

const KW_CN: Record<Keyword, string> = Object.fromEntries(
  Object.entries(KEYWORD_DEFS).map(([k, v]) => [k, v.name]),
) as Record<Keyword, string>;
const ROW_CN: Record<Row, string> = { front: '前锋', back: '后营' };

/** 一次大模型调用的调试记录（输入/输出/耗时/错误） */
export interface LlmDebugRecord {
  turn: number;
  at: string;
  model: string;
  durationMs: number;
  prompt: string;
  response?: string;
  error?: string;
}

export const SYSTEM_PROMPT = `你是一名卡牌对战高手，扮演江湖幕后执棋人与玩家进行 1v1 卡牌对战。轮到你行动时，根据局面输出这一整回合的动作序列。

【规则速览】把对手气血打到 0 获胜。内力每回合上限+1并回满，出牌消耗内力。战场每方前锋(front)6格(slot 0-5)、后营(back)3格(slot 0-2)。
近战单位只能攻击敌方前锋；敌方前锋全空时，近战才能攻击后营或对方玩家("player")。远程单位可攻击任意目标。
敌方有「护卫」时，攻击必须优先以护卫为目标。「渗透」单位无视前锋阻挡。单位打出当回合不能攻击，「速攻」除外。
「易容」单位盖放打出，对外显示为 1/1 路人；攻击、被攻击或被指定时翻开。「埋伏」牌盖放在埋伏区（最多 3 张），敌方单位攻击时触发。
伤害法术（如「袖里剑」）需要指定一个敌方单位作为 target；传功/淬毒牌需要指定一个你自己的单位作为 target。

【输出要求】只输出一个 JSON 对象，不要输出任何解释或 markdown：
{"comment":"一句简短的江湖风台词，展现你的自信或读心","actions":[动作序列]}
动作格式：
出牌 {"type":"play_card","card":"卡牌名","row":"front","slot":0}（row/slot 可省略，会自动安排）
法术 {"type":"play_card","card":"袖里剑","target":{"row":"front","slot":0}}
攻击 {"type":"attack","attacker":{"row":"front","slot":0},"target":"player"}（target 也可以是敌方单位 {"row":"back","slot":1}）
结束 {"type":"end_turn"}（必须是最后一个动作）

【重要】局面信息里已经帮你算好：每张手牌费用是否足够（★=本回合可打出）、每个可攻击单位的全部合法目标。
出牌只用★标注的牌，攻击只从给出的合法目标里选，不要发明目标。`;

// ==================== Prompt 构造 ====================

function cellText(u: GameState['players'][0]['board']['front'][number]): string {
  if (!u) return '空';
  const kws = u.keywords.map((k) => KW_CN[k] ?? k).join('/');
  const status = u.sick ? ',休整中' : u.attacked ? ',已攻击' : '';
  return `${u.name}(${u.atk}/${u.hp}${kws ? ',' + kws : ''}${status})`;
}

/** AI 通过侦测获得的情报（对手手牌快照） */
export interface AiIntel {
  turn: number;
  hand: string[];
}

/** 把当前局面 + 合法目标提示 + 最近战况渲染成给模型的文本 */
export function buildPrompt(state: GameState, side: PlayerIndex, recentLog: string[], intel?: AiIntel | null): string {
  const me = state.players[side];
  const foe = state.players[side === 0 ? 1 : 0];
  const lines: string[] = [];

  lines.push(`第 ${state.turn} 回合，轮到你行动。`);
  lines.push(`你: 气血${me.hp}/${me.maxHp} 内力${me.mana}/${me.maxMana} 牌库${me.deck.length}张`);
  lines.push(`对手: 气血${foe.hp} 手牌${foe.hand.length}张 牌库${foe.deck.length}张`);

  // 手牌（标注费用是否足够）
  lines.push('你的手牌（★=本回合费用足够可打出）:');
  if (me.hand.length === 0) lines.push('  (无)');
  me.hand.forEach((id) => {
    const c = CARDS[id];
    if (!c) return;
    const star = c.cost <= me.mana ? '★' : '✩';
    const stat = c.kind === 'unit' ? `${c.atk}/${c.hp}` : c.kind === 'buff' ? '传功' : c.kind === 'trap' ? '埋伏' : '法术';
    const kws = c.keywords?.length ? ` 关键词:${c.keywords.map((k) => KW_CN[k] ?? k).join('/')}` : '';
    lines.push(`  ${star}${c.name} ${c.cost}费 ${stat}${kws} - ${c.desc}`);
  });

  // 战场
  const boardLine = (b: GameState['players'][0]['board'], label: string): void => {
    const rowText = (row: (UnitState | null)[]): string => row.map((u, i) => `[${i}]${cellText(u)}`).join(' ');
    lines.push(`  ${label}前锋: ${rowText(b.front)}`);
    lines.push(`  ${label}后营: ${rowText(b.back)}`);
  };
  lines.push('战场:');
  boardLine(me.board, '你的');
  boardLine(foe.board, '敌方');

  // 合法攻击目标（模型直接做选择题）
  lines.push('你可以执行的攻击（目标只能从列出的里面选）:');
  let hasAttack = false;
  for (const row of ['front', 'back'] as const) {
    me.board[row].forEach((u, slot) => {
      if (!u || u.sick || u.attacked) return;
      const targets = legalTargets(state, side, { row, slot });
      if (targets.length === 0) return;
      hasAttack = true;
      const tText = targets
        .map((t) => {
          if (t === 'player') return '对方玩家';
          const tu = foe.board[t.row][t.slot];
          return `敌方${ROW_CN[t.row]}[${t.slot}]${tu?.name ?? ''}`;
        })
        .join(' | ');
      lines.push(`  你的${ROW_CN[row]}[${slot}]${u.name}(攻${u.atk}) → ${tText}`);
    });
  }
  if (!hasAttack) lines.push('  (本回合暂无可攻击单位)');

  // 短期记忆
  if (recentLog.length > 0) {
    lines.push('最近战况:');
    for (const l of recentLog.slice(-10)) lines.push(`  ${l}`);
  }

  // 识破情报
  if (intel && intel.hand.length > 0) {
    const names = intel.hand.map((id) => CARDS[id]?.name ?? id).join('、');
    lines.push(`【情报】你在第 ${intel.turn} 回合识破了对手的手牌: ${names}（此后对手可能已打出或抽到新的牌）`);
  }

  lines.push('请输出你的回合动作 JSON。');
  return lines.join('\n');
}

// ==================== 模型输出解析 ====================

/** 从模型输出中提取 { comment, actions }；尽量容错（markdown 围栏、前后废话） */
export function parseModelResponse(text: string): AiTurn | null {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  // 从第一个 { 开始，找与其匹配的最后一个 }
  const end = cleaned.lastIndexOf('}');
  if (end <= start) return null;
  let parsed: { comment?: unknown; actions?: unknown };
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.actions)) return null;
  const actions = parsed.actions.filter(
    (a): a is AiAction => !!a && typeof a === 'object' && typeof (a as { type?: unknown }).type === 'string',
  );
  return {
    actions,
    comment: typeof parsed.comment === 'string' ? parsed.comment.slice(0, 60) : undefined,
  };
}

// ==================== 动作翻译：卡牌名 → 引擎动作 ====================

/**
 * 把模型动作翻译成引擎 GameAction。
 * 必须在执行前一刻针对当时的 state 调用（手牌下标随出牌变化）。
 */
export function resolveAiAction(raw: AiAction, state: GameState, side: PlayerIndex): GameAction | null {
  if (raw.type === 'end_turn') return { type: 'end_turn' };

  if (raw.type === 'attack') {
    if (!raw.attacker || !raw.target) return null;
    return { type: 'attack', attacker: raw.attacker, target: raw.target };
  }

  // play_card
  const me = state.players[side];
  let idx = -1;
  if (typeof raw.card === 'string' && raw.card) {
    idx = me.hand.findIndex((id) => id === raw.card || CARDS[id]?.name === raw.card);
  }
  if (idx === -1 && typeof raw.handIndex === 'number') idx = raw.handIndex; // 兼容旧格式
  if (idx < 0 || idx >= me.hand.length) return null;

  const def = CARDS[me.hand[idx]];
  if (!def) return null;

  if (def.kind === 'unit') {
    const row: Row = raw.row === 'front' || raw.row === 'back' ? raw.row : def.keywords?.includes('ranged') ? 'back' : 'front';
    let slot = typeof raw.slot === 'number' ? raw.slot : -1;
    // 指定位置无效或被占时，自动找该排第一个空位
    if (slot < 0 || slot >= me.board[row].length || me.board[row][slot]) {
      slot = me.board[row].findIndex((x) => x === null);
    }
    if (slot === -1) return null; // 该排已满
    return { type: 'play_card', handIndex: idx, row, slot };
  }

  // 埋伏牌：无需目标，直接打出
  if (def.kind === 'trap') {
    return { type: 'play_card', handIndex: idx, row: 'front', slot: 0 };
  }

  // 传功/淬毒：target 指向自己的单位；模型没给就选攻最高的
  if (def.kind === 'buff') {
    let target = raw.target && raw.target !== 'player' ? raw.target : null;
    if (!target || !me.board[target.row][target.slot]) {
      let best: { ref: UnitRef; atk: number } | null = null;
      for (const row of ['front', 'back'] as const) {
        me.board[row].forEach((u, slot) => {
          if (u && (!best || u.atk > best.atk)) best = { ref: { row, slot }, atk: u.atk };
        });
      }
      if (!best) return null;
      target = (best as { ref: UnitRef; atk: number }).ref;
    }
    return { type: 'play_card', handIndex: idx, row: 'front', slot: 0, target };
  }

  // 法术
  // 识破类法术（reveal_unit）：目标必须是敌方盖放单位，模型没给就选第一个
  const needsReveal = (def.effects ?? []).some((e) => e.actions.some((a) => a.kind === 'reveal_unit'));
  if (needsReveal) {
    const foe = state.players[side === 0 ? 1 : 0];
    let target = raw.target && raw.target !== 'player' ? raw.target : null;
    if (!target || !foe.board[target.row][target.slot]?.faceDown) {
      target = null;
      for (const row of ['front', 'back'] as const) {
        for (let slot = 0; slot < foe.board[row].length; slot++) {
          if (foe.board[row][slot]?.faceDown) {
            target = { row, slot };
            break;
          }
        }
        if (target) break;
      }
    }
    if (!target) return null;
    return { type: 'play_card', handIndex: idx, row: 'front', slot: 0, target };
  }
  const needsTarget = (def.effects ?? []).some((e) => e.actions.some((a) => a.kind === 'damage'));
  if (needsTarget) {
    if (!raw.target || raw.target === 'player') return null;
    return { type: 'play_card', handIndex: idx, row: 'front', slot: 0, target: raw.target };
  }
  return { type: 'play_card', handIndex: idx, row: 'front', slot: 0 };
}

// ==================== API 调用 ====================

export async function requestDeepseekTurn(
  apiKey: string,
  model: string,
  state: GameState,
  side: PlayerIndex,
  recentLog: string[],
  onDebug?: (record: LlmDebugRecord) => void,
  intel?: AiIntel | null,
  timeoutMs = 20000,
): Promise<AiTurn> {
  const prompt = buildPrompt(state, side, recentLog, intel);
  const startedAt = Date.now();
  const at = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  let recorded = false;
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
        response_format: { type: 'json_object' }, // 强制合法 JSON
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Deepseek API 错误: ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? '';
    // 先记录原始响应（即使后续解析失败也能看到模型实际输出）
    onDebug?.({ turn: state.turn, at, model, durationMs: Date.now() - startedAt, prompt, response: content });
    recorded = true;
    const turn = parseModelResponse(content);
    if (!turn || turn.actions.length === 0) throw new Error('大模型返回无法解析');
    return turn;
  } catch (e) {
    if (!recorded) {
      onDebug?.({
        turn: state.turn,
        at,
        model,
        durationMs: Date.now() - startedAt,
        prompt,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
