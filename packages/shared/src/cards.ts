import rawCards from './data/cards.json' with { type: 'json' };
import { KEYWORD_DEFS, FACTION_DEFS } from './keywords.js';
import type { CardDef } from './types.js';

/**
 * 卡池装配：从 data/cards.json 加载并做启动时校验。
 * 数值基准见 DESIGN.md 第 5 节；术语与门派设定见第 2、6 节。
 */

const KINDS = new Set(['unit', 'spell', 'buff', 'trap']);

function validateCard(raw: unknown): CardDef {
  const c = raw as CardDef;
  const fail = (msg: string): never => {
    throw new Error(`卡牌数据非法 [${c?.id ?? '?'}]: ${msg}`);
  };
  if (!c.id || typeof c.id !== 'string') fail('缺少 id');
  if (!c.name || typeof c.name !== 'string') fail('缺少 name');
  if (!Number.isInteger(c.cost) || c.cost < 0 || c.cost > 10) fail('cost 必须是 0~10 的整数');
  if (!KINDS.has(c.kind)) fail(`kind 必须是 ${[...KINDS].join('/')}`);
  if (c.faction !== undefined && !(c.faction in FACTION_DEFS)) fail(`未知门派 ${c.faction}`);
  for (const kw of c.keywords ?? []) {
    if (!(kw in KEYWORD_DEFS)) fail(`未知关键词 ${kw}`);
  }
  if (c.kind === 'unit') {
    if (!Number.isInteger(c.atk) || !Number.isInteger(c.hp)) fail('单位必须有整数 atk/hp');
    const rangeKws = (c.keywords ?? []).filter((k) => k === 'melee' || k === 'ranged');
    if (rangeKws.length !== 1) fail('单位必须且只能有一个攻击范围关键词（melee/ranged）');
  }
  if (c.kind === 'spell' && (!c.effects || c.effects.length === 0)) fail('法术必须有 effects');
  if (c.kind === 'buff' && !c.buff) fail('强化牌必须有 buff 定义');
  if (c.kind === 'trap' && !c.trap) fail('埋伏牌必须有 trap 定义');
  if (typeof c.desc !== 'string') fail('缺少 desc');
  return c;
}

function loadCards(): Record<string, CardDef> {
  const out: Record<string, CardDef> = {};
  for (const raw of rawCards) {
    const def = validateCard(raw);
    if (out[def.id]) throw new Error(`卡牌 id 重复: ${def.id}`);
    out[def.id] = def;
  }
  return out;
}

export const CARDS: Record<string, CardDef> = loadCards();

/** v0 预组卡组：每种非衍生牌 2 张。构筑系统后续版本加入。 */
export function buildStarterDeck(): string[] {
  const deck: string[] = [];
  for (const def of Object.values(CARDS)) {
    if (def.token) continue;
    deck.push(def.id, def.id);
  }
  return deck;
}
