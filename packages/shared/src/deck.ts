import { CARDS } from './cards.js';
import type { Faction } from './types.js';

/**
 * 牌组（Deck）规则与校验。
 * 客户端组牌器与服务器开局校验共用同一份，防止非法牌组进入对局。
 *
 * 规则：20 张、同名卡 ≤2、只能含一个门派的门派卡（外加中立卡）、衍生牌不可入组。
 * 注：DESIGN 原为 30 张，但当前卡池（17 种非衍生卡）在 30 张/同名≤2/单门派下
 * 组不出合法牌组，故定为 20 张，卡池扩充后再上调（同步改 DESIGN.md 第 3 节）。
 */

export const DECK_SIZE = 20;
export const SAME_CARD_LIMIT = 2;

export interface Deck {
  id: string;
  name: string;
  cards: string[]; // DECK_SIZE 个 cardId，重复表示多张
}

/** 校验牌组合法性；合法返回 null，否则返回错误原因 */
export function validateDeck(cards: string[]): string | null {
  if (cards.length !== DECK_SIZE) return `牌组必须恰好 ${DECK_SIZE} 张（当前 ${cards.length} 张）`;
  const counts = new Map<string, number>();
  const factions = new Set<Faction>();
  for (const id of cards) {
    const def = CARDS[id];
    if (!def) return `未知卡牌：${id}`;
    if (def.token) return `「${def.name}」是衍生牌，不能加入牌组`;
    const n = (counts.get(id) ?? 0) + 1;
    if (n > SAME_CARD_LIMIT) return `「${def.name}」最多带 ${SAME_CARD_LIMIT} 张`;
    counts.set(id, n);
    if (def.faction) factions.add(def.faction);
  }
  if (factions.size > 1) return '牌组只能包含一个门派的门派卡（外加中立卡）';
  return null;
}

/** 牌组所属门派（全中立时返回 null） */
export function deckFaction(cards: string[]): Faction | null {
  for (const id of cards) {
    const f = CARDS[id]?.faction;
    if (f) return f;
  }
  return null;
}

/** 新手默认牌组：中立 8 种 ×2 + 铁脊山庄 2 种 ×2 = 20 张（保证合法） */
export function buildDefaultDeck(): string[] {
  const neutral: string[] = [];
  const tieji: string[] = [];
  for (const def of Object.values(CARDS)) {
    if (def.token) continue;
    if (!def.faction) neutral.push(def.id, def.id);
    else if (def.faction === 'tieji') tieji.push(def.id, def.id);
  }
  const deck = [...neutral, ...tieji];
  if (validateDeck(deck) !== null) throw new Error('默认牌组不合法，卡池结构已变化');
  return deck;
}
