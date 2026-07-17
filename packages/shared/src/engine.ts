import { CARDS } from './cards.js';
import { createRng, shuffle } from './rng.js';
import type {
  BoardState,
  GameAction,
  GameEvent,
  GameState,
  GameView,
  Keyword,
  PlayerIndex,
  PlayerState,
  TargetRef,
  UnitRef,
  UnitState,
} from './types.js';

export const BOARD_SLOTS = 3;
export const HAND_LIMIT = 10;
export const MANA_LIMIT = 10;
export const START_HP = 30;

const other = (p: PlayerIndex): PlayerIndex => (p === 0 ? 1 : 0);

function emptyBoard(): BoardState {
  return { front: [null, null, null], back: [null, null, null] };
}

function createPlayer(deck: string[]): PlayerState {
  return {
    hp: START_HP,
    maxHp: START_HP,
    mana: 0,
    maxMana: 0,
    deck,
    hand: [],
    fatigue: 0,
    board: emptyBoard(),
  };
}

/** 创建一局新游戏。deckA/deckB 为 cardId 列表，seed 决定洗牌顺序。 */
export function createGame(deckA: string[], deckB: string[], seed: number): GameState {
  const rng = createRng(seed);
  const state: GameState = {
    players: [createPlayer(shuffle([...deckA], rng)), createPlayer(shuffle([...deckB], rng))],
    turn: 0,
    current: 0,
    uidCounter: 1,
    winner: null,
  };
  // 起始手牌：先手 3 张，后手 4 张
  drawCards(state, 0, 3, []);
  drawCards(state, 1, 4, []);
  return state;
}

export function unitAt(state: GameState, side: PlayerIndex, ref: UnitRef): UnitState | null {
  return state.players[side].board[ref.row][ref.slot] ?? null;
}

function hasKw(u: UnitState, kw: Keyword): boolean {
  return u.keywords.includes(kw);
}

function allUnits(state: GameState, side: PlayerIndex): { ref: UnitRef; unit: UnitState }[] {
  const out: { ref: UnitRef; unit: UnitState }[] = [];
  for (const row of ['front', 'back'] as const) {
    state.players[side].board[row].forEach((u, slot) => {
      if (u) out.push({ ref: { row, slot }, unit: u });
    });
  }
  return out;
}

/** 抽 n 张牌；牌库空则疲劳掉血；手牌满则爆牌。 */
function drawCards(state: GameState, side: PlayerIndex, n: number, events: GameEvent[]): void {
  const p = state.players[side];
  for (let i = 0; i < n; i++) {
    if (p.deck.length === 0) {
      p.fatigue += 1;
      p.hp -= p.fatigue;
      events.push({ type: 'fatigue', player: side, damage: p.fatigue });
      continue;
    }
    const card = p.deck.shift()!;
    if (p.hand.length >= HAND_LIMIT) {
      events.push({ type: 'burn', player: side, card });
      continue;
    }
    p.hand.push(card);
    events.push({ type: 'draw', player: side, cards: [card] });
  }
}

function checkWinner(state: GameState, events: GameEvent[]): void {
  const dead = ([0, 1] as PlayerIndex[]).filter((i) => state.players[i].hp <= 0);
  if (dead.length === 0) return;
  // 双方同时归零时，判当前行动方负（其行动导致）
  const winner: PlayerIndex = dead.length === 2 ? other(state.current) : other(dead[0]);
  state.winner = winner;
  events.push({ type: 'game_over', winner });
}

/** 回合开始：法力 +1 回满、单位重置、抽 1 张 */
function startTurn(state: GameState, events: GameEvent[]): void {
  state.turn += 1;
  const p = state.players[state.current];
  p.maxMana = Math.min(MANA_LIMIT, p.maxMana + 1);
  p.mana = p.maxMana;
  for (const { unit } of allUnits(state, state.current)) {
    unit.sick = false;
    unit.attacked = false;
  }
  events.push({ type: 'turn_start', player: state.current, turn: state.turn, mana: p.maxMana });
  drawCards(state, state.current, 1, events);
  checkWinner(state, events); // 疲劳可能直接抽死
}

/** 某单位当前合法攻击目标（客户端高亮 + 服务器校验共用） */
export function legalTargets(state: GameState, side: PlayerIndex, attackerRef: UnitRef): TargetRef[] {
  const u = unitAt(state, side, attackerRef);
  if (!u || u.sick || u.attacked || state.winner !== null) return [];
  const foe = other(side);
  const foeUnits = allUnits(state, foe);
  const guards = foeUnits.filter(({ unit }) => hasKw(unit, 'guard'));
  // 护卫（嘲讽）：必须优先攻击
  if (guards.length > 0) return guards.map(({ ref }) => ref);

  const targets: TargetRef[] = foeUnits.map(({ ref }) => ref);
  const frontBlocked = state.players[foe].board.front.some((x) => x !== null);
  const ranged = hasKw(u, 'ranged');
  const infiltrate = hasKw(u, 'infiltrate');
  if (ranged || infiltrate || !frontBlocked) {
    targets.push('player');
  } else {
    // 近战且被前排挡住：只能打前排
    return targets.filter((t) => t !== 'player' && t.row === 'front');
  }
  return targets;
}

type Result = { ok: true; state: GameState; events: GameEvent[] } | { ok: false; error: string };

/** 应用一个动作。纯函数式：不改动入参 state，返回新 state 与事件流。 */
export function applyAction(prev: GameState, side: PlayerIndex, action: GameAction): Result {
  if (prev.winner !== null) return { ok: false, error: '对局已结束' };
  if (side !== prev.current) return { ok: false, error: '还没轮到你行动' };

  const state = structuredClone(prev);
  const events: GameEvent[] = [];

  switch (action.type) {
    case 'end_turn': {
      events.push({ type: 'turn_end', player: side });
      state.current = other(side);
      startTurn(state, events);
      return { ok: true, state, events };
    }
    case 'play_card':
      return playCard(state, side, action, events);
    case 'attack':
      return attack(state, side, action, events);
  }
}

function playCard(
  state: GameState,
  side: PlayerIndex,
  action: Extract<GameAction, { type: 'play_card' }>,
  events: GameEvent[],
): Result {
  const p = state.players[side];
  const cardId = p.hand[action.handIndex];
  if (!cardId) return { ok: false, error: '手牌序号无效' };
  const def = CARDS[cardId];
  if (!def) return { ok: false, error: '未知卡牌' };
  if (def.cost > p.mana) return { ok: false, error: '法力不足' };

  if (def.kind === 'unit') {
    if (action.slot < 0 || action.slot >= BOARD_SLOTS) return { ok: false, error: '格子序号无效' };
    if (p.board[action.row][action.slot]) return { ok: false, error: '该位置已有单位' };
    const unit: UnitState = {
      uid: state.uidCounter++,
      cardId,
      name: def.name,
      atk: def.atk!,
      hp: def.hp!,
      maxHp: def.hp!,
      keywords: [...(def.keywords ?? [])],
      sick: !(def.keywords ?? []).includes('charge'),
      attacked: false,
    };
    p.mana -= def.cost;
    p.hand.splice(action.handIndex, 1);
    p.board[action.row][action.slot] = unit;
    events.push({ type: 'play_card', player: side, card: cardId, row: action.row, slot: action.slot });
    return { ok: true, state, events };
  }

  // 法术牌
  const eff = def.effect!;
  if (eff.kind === 'damage') {
    const t = action.target;
    if (!t || t === 'player') return { ok: false, error: '该法术需要一个敌方单位目标' };
    const target = unitAt(state, other(side), t);
    if (!target) return { ok: false, error: '目标无效' };
    p.mana -= def.cost;
    p.hand.splice(action.handIndex, 1);
    target.hp -= eff.amount;
    events.push({ type: 'play_card', player: side, card: cardId, target: t });
    events.push({ type: 'damage', target: t, amount: eff.amount, source: cardId });
    removeDead(state, events);
  } else if (eff.kind === 'draw') {
    p.mana -= def.cost;
    p.hand.splice(action.handIndex, 1);
    events.push({ type: 'play_card', player: side, card: cardId });
    drawCards(state, side, eff.amount, events);
  } else if (eff.kind === 'reveal_hand') {
    p.mana -= def.cost;
    p.hand.splice(action.handIndex, 1);
    events.push({ type: 'play_card', player: side, card: cardId });
    // 侦测：把对手手牌快照发给施放者（filterEventsFor 会保证只有施放者可见）
    events.push({ type: 'reveal', player: side, hand: [...state.players[other(side)].hand] });
  }
  checkWinner(state, events);
  return { ok: true, state, events };
}

function attack(
  state: GameState,
  side: PlayerIndex,
  action: Extract<GameAction, { type: 'attack' }>,
  events: GameEvent[],
): Result {
  const attacker = unitAt(state, side, action.attacker);
  if (!attacker) return { ok: false, error: '攻击单位不存在' };
  if (attacker.sick) return { ok: false, error: '该单位本回合无法行动（召唤失调）' };
  if (attacker.attacked) return { ok: false, error: '该单位本回合已攻击过' };
  const legal = legalTargets(state, side, action.attacker);
  const ok = legal.some((t) =>
    t === 'player' ? action.target === 'player' : action.target !== 'player' && t.row === action.target.row && t.slot === action.target.slot,
  );
  if (!ok) return { ok: false, error: '该目标不可攻击（前排阻挡/护卫限制）' };

  attacker.attacked = true;
  const foe = other(side);
  if (action.target === 'player') {
    state.players[foe].hp -= attacker.atk;
    events.push({ type: 'attack', attacker: action.attacker, target: 'player', damage: attacker.atk });
  } else {
    const defender = unitAt(state, foe, action.target)!;
    defender.hp -= attacker.atk;
    attacker.hp -= defender.atk;
    events.push({
      type: 'attack',
      attacker: action.attacker,
      target: action.target,
      damage: attacker.atk,
      counter: defender.atk,
    });
    removeDead(state, events);
  }
  checkWinner(state, events);
  return { ok: true, state, events };
}

function removeDead(state: GameState, events: GameEvent[]): void {
  for (const side of [0, 1] as PlayerIndex[]) {
    for (const row of ['front', 'back'] as const) {
      state.players[side].board[row].forEach((u, slot) => {
        if (u && u.hp <= 0) {
          state.players[side].board[row][slot] = null;
          events.push({ type: 'death', player: side, row, slot, card: u.cardId });
        }
      });
    }
  }
}

/** 生成某个玩家的视角状态：对手手牌与牌库内容不下发（信息隐藏的技术前提）。 */
export function getView(state: GameState, side: PlayerIndex): GameView {
  const me = state.players[side];
  const opp = state.players[other(side)];
  return {
    me: {
      hp: me.hp,
      maxHp: me.maxHp,
      mana: me.mana,
      maxMana: me.maxMana,
      hand: [...me.hand],
      deckCount: me.deck.length,
      board: me.board,
      fatigue: me.fatigue,
    },
    opp: {
      hp: opp.hp,
      maxHp: opp.maxHp,
      mana: opp.mana,
      maxMana: opp.maxMana,
      handCount: opp.hand.length,
      deckCount: opp.deck.length,
      board: opp.board,
      fatigue: opp.fatigue,
    },
    current: state.current,
    mySide: side,
    turn: state.turn,
    winner: state.winner,
  };
}

/**
 * 按玩家视角过滤事件流：
 * - 对手抽到的牌不下发具体内容（只保留数量）
 * - 侦测（reveal）结果只发给施放者
 */
export function filterEventsFor(events: GameEvent[], side: PlayerIndex): GameEvent[] {
  return events
    .map((e) => {
      if (e.type === 'draw' && e.player !== side) {
        return { type: 'draw', player: e.player, count: (e.cards as string[]).length };
      }
      if (e.type === 'burn' && e.player !== side) {
        return { type: 'burn', player: e.player };
      }
      return e;
    })
    .filter((e) => {
      if (e.type === 'reveal') return e.player === side;
      return true;
    });
}
