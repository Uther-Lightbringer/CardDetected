import { CARDS } from './cards.js';
import { NOISE_CARD_ID } from './keywords.js';
import { createRng, shuffle } from './rng.js';
import type {
  AppliedBuff,
  BoardState,
  CardDef,
  EffectAction,
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

/** 战场格数：前锋 6 格 + 后营 3 格 */
export const FRONT_SLOTS = 6;
export const BACK_SLOTS = 3;
/** 埋伏区格数 */
export const TRAP_SLOTS = 3;
export const HAND_LIMIT = 10;
export const MANA_LIMIT = 10;
export const START_HP = 30;

const other = (p: PlayerIndex): PlayerIndex => (p === 0 ? 1 : 0);

function emptyBoard(): BoardState {
  return {
    front: Array.from({ length: FRONT_SLOTS }, () => null),
    back: Array.from({ length: BACK_SLOTS }, () => null),
  };
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
    traps: Array.from({ length: TRAP_SLOTS }, () => null),
  };
}

/** 创建一局新游戏。deckA/deckB 为 cardId 列表，seed 决定洗牌顺序。 */
export function createGame(deckA: string[], deckB: string[], seed: number): GameState {
  const rng = createRng(seed);
  const state: GameState = {
    players: [createPlayer(shuffle([...deckA], rng)), createPlayer(shuffle([...deckB], rng))],
    turn: 1, // 开局即先手的第 1 回合（原实现 turn=0，首回合不计数且先手 0 内力只能空过）
    current: 0,
    uidCounter: 1,
    winner: null,
  };
  // 起始手牌：先手 3 张，后手 4 张
  drawCards(state, 0, 3, []);
  drawCards(state, 1, 4, []);
  // 先手首回合内力 1 点（后手结束回合时由 startTurn 正常 +1）
  state.players[0].maxMana = 1;
  state.players[0].mana = 1;
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

/** 易容单位若「翻开时」带 self_ready，休整不妨碍其宣告攻击（翻开即清除休整） */
function revealReadies(u: UnitState): boolean {
  if (!u.faceDown) return false;
  const def = CARDS[u.cardId];
  return (def?.effects ?? []).some(
    (e) => e.trigger === 'on_reveal' && e.actions.some((a) => a.kind === 'self_ready'),
  );
}

/** 某单位当前合法攻击目标（客户端高亮 + 服务器校验共用） */
export function legalTargets(state: GameState, side: PlayerIndex, attackerRef: UnitRef): TargetRef[] {
  const u = unitAt(state, side, attackerRef);
  if (!u || u.attacked || state.winner !== null) return [];
  if (u.sick && !revealReadies(u)) return [];
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
  if (def.cost > p.mana) return { ok: false, error: '内力不足' };

  if (def.kind === 'unit') {
    const slots = p.board[action.row];
    if (action.slot < 0 || action.slot >= slots.length) return { ok: false, error: '格子序号无效' };
    if (slots[action.slot]) return { ok: false, error: '该位置已有单位' };
    const targetErr = validateEffectTarget(state, side, def, action.target);
    if (targetErr) return { ok: false, error: targetErr };
    // 易容单位一律盖放打出（MVP：不提供明放选项）
    const faceDown = (def.keywords ?? []).includes('stealth');
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
      faceDown,
      buffs: [],
    };
    p.mana -= def.cost;
    p.hand.splice(action.handIndex, 1);
    slots[action.slot] = unit;
    events.push({
      type: 'play_card',
      player: side,
      card: cardId,
      row: action.row,
      slot: action.slot,
      ...(faceDown ? { faceDown: true } : {}),
    });
    runEffects(state, side, def, action.target, events); // 战吼
    removeDead(state, events);
    checkWinner(state, events);
    return { ok: true, state, events };
  }

  if (def.kind === 'trap') {
    // 埋伏牌：无需目标与格子，放入埋伏区第一个空位
    const slot = p.traps.findIndex((t) => t === null);
    if (slot === -1) return { ok: false, error: '埋伏区已满' };
    p.mana -= def.cost;
    p.hand.splice(action.handIndex, 1);
    p.traps[slot] = cardId;
    events.push({ type: 'play_card', player: side, card: cardId, trap: true });
    return { ok: true, state, events };
  }

  if (def.kind === 'buff') {
    const t = action.target;
    if (!t || t === 'player') return { ok: false, error: '传功/淬毒需要一个友方单位目标' };
    const target = unitAt(state, side, t);
    if (!target) return { ok: false, error: '目标无效：只能贴附自己的单位' };
    p.mana -= def.cost;
    p.hand.splice(action.handIndex, 1);
    applyBuff(target, def);
    events.push({ type: 'play_card', player: side, card: cardId, target: t });
    events.push({ type: 'buff', player: side, target: t, card: cardId, name: def.name });
    return { ok: true, state, events };
  }

  // 法术牌
  const targetErr = validateEffectTarget(state, side, def, action.target);
  if (targetErr) return { ok: false, error: targetErr };
  p.mana -= def.cost;
  p.hand.splice(action.handIndex, 1);
  events.push({ type: 'play_card', player: side, card: cardId, ...(action.target ? { target: action.target } : {}) });
  // 法术指定易容单位为目标时，在效果结算前正常翻开；
  // 含强制翻开动作的卡牌除外（由 reveal_unit 处理器以「被识破」方式翻开）
  const hasRevealUnit = (def.effects ?? []).some((e) => e.actions.some((a) => a.kind === 'reveal_unit'));
  if (action.target && action.target !== 'player' && !hasRevealUnit) {
    const t = unitAt(state, other(side), action.target);
    if (t?.faceDown) revealUnit(state, other(side), action.target, events, false);
  }
  runEffects(state, side, def, action.target, events);
  removeDead(state, events);
  checkWinner(state, events);
  return { ok: true, state, events };
}

/**
 * 翻开一个易容单位。
 * forced=false 正常翻开：结算其「翻开时」（on_reveal）效果；
 * forced=true 被识破（照妖镜）：不结算 on_reveal，且当回合休整。
 */
function revealUnit(state: GameState, side: PlayerIndex, ref: UnitRef, events: GameEvent[], forced: boolean): void {
  const u = unitAt(state, side, ref);
  if (!u || !u.faceDown) return;
  u.faceDown = false;
  events.push({ type: 'unit_reveal', player: side, ref, card: u.cardId, ...(forced ? { forced: true } : {}) });
  if (forced) {
    u.sick = true;
    return;
  }
  const def = CARDS[u.cardId];
  for (const eff of def?.effects ?? []) {
    if (eff.trigger !== 'on_reveal') continue;
    for (const a of eff.actions) {
      (EFFECT_HANDLERS[a.kind] as (ctx: EffectCtx, action: EffectAction) => void)(
        { state, side, selfRef: ref, source: u.cardId, events },
        a,
      );
    }
  }
}

/** 法术/战吼的目标预校验：含 damage 动作时必须指定一个敌方单位；含 reveal_unit 时必须指定一个敌方盖放单位 */
function validateEffectTarget(
  state: GameState,
  side: PlayerIndex,
  def: CardDef,
  target: TargetRef | undefined,
): string | null {
  const actions = (def.effects ?? []).flatMap((e) => e.actions);
  const needsEnemyUnit = actions.some((a) => a.kind === 'damage');
  if (needsEnemyUnit) {
    if (!target || target === 'player') return '该卡牌需要一个敌方单位目标';
    if (!unitAt(state, other(side), target)) return '目标无效';
  }
  const needsReveal = actions.some((a) => a.kind === 'reveal_unit');
  if (needsReveal) {
    if (!target || target === 'player') return '该卡牌需要一个敌方易容单位目标';
    const u = unitAt(state, other(side), target);
    if (!u) return '目标无效';
    if (!u.faceDown) return '目标不是易容单位';
  }
  return null;
}

function runEffects(
  state: GameState,
  side: PlayerIndex,
  def: CardDef,
  target: TargetRef | undefined,
  events: GameEvent[],
): void {
  for (const eff of def.effects ?? []) {
    if (eff.trigger !== 'on_play') continue;
    for (const a of eff.actions) {
      (EFFECT_HANDLERS[a.kind] as (ctx: EffectCtx, action: EffectAction) => void)(
        { state, side, target, source: def.id, events },
        a,
      );
    }
  }
}

interface EffectCtx {
  state: GameState;
  side: PlayerIndex;
  target?: TargetRef;
  /** 效果来源单位（如「翻开时」效果指向自身） */
  selfRef?: UnitRef;
  /** 触发者（如触发埋伏的攻击单位） */
  triggerRef?: UnitRef;
  source: string;
  events: GameEvent[];
}

type Handler<A extends EffectAction['kind']> = (ctx: EffectCtx, a: Extract<EffectAction, { kind: A }>) => void;

/**
 * 原子效果处理器注册表：新效果只需在 types.ts 的 EffectAction 加一种、在这里登记处理器，
 * 引擎主干（出牌/攻击/胜负结算）不需要改动。
 */
export const EFFECT_HANDLERS: { [A in EffectAction['kind']]: Handler<A> } = {
  damage: (ctx, a) => {
    const t = ctx.target;
    if (!t || t === 'player') return; // 已经过 validateEffectTarget 校验
    const u = unitAt(ctx.state, other(ctx.side), t);
    if (!u) return;
    u.hp -= a.amount;
    ctx.events.push({ type: 'damage', player: ctx.side, target: t, amount: a.amount, source: ctx.source });
  },
  draw: (ctx, a) => {
    drawCards(ctx.state, ctx.side, a.amount, ctx.events);
  },
  reveal_hand: (ctx) => {
    // 识破：把对手手牌快照发给施放者（filterEventsFor 会保证只有施放者可见）
    ctx.events.push({ type: 'reveal', player: ctx.side, hand: [...ctx.state.players[other(ctx.side)].hand] });
  },
  pollute: (ctx, a) => {
    // 下毒：洗 N 张蛊奴进对手牌库
    const foeDeck = ctx.state.players[other(ctx.side)].deck;
    for (let i = 0; i < a.amount; i++) foeDeck.push(NOISE_CARD_ID);
    seededShuffle(ctx.state, foeDeck);
    ctx.events.push({ type: 'pollute', player: ctx.side, amount: a.amount });
  },
  purify: (ctx) => {
    // 驱毒：移除自己牌库中所有蛊奴
    const me = ctx.state.players[ctx.side];
    const before = me.deck.length;
    me.deck = me.deck.filter((c) => c !== NOISE_CARD_ID);
    ctx.events.push({ type: 'purify', player: ctx.side, removed: before - me.deck.length });
  },
  shuffle_opp_deck: (ctx) => {
    seededShuffle(ctx.state, ctx.state.players[other(ctx.side)].deck);
    ctx.events.push({ type: 'shuffle_deck', player: ctx.side });
  },
  damage_per_noise: (ctx, a) => {
    const foe = other(ctx.side);
    const n = ctx.state.players[foe].deck.filter((c) => c === NOISE_CARD_ID).length;
    const dmg = n * a.amount;
    ctx.state.players[foe].hp -= dmg;
    ctx.events.push({ type: 'damage', player: ctx.side, target: 'player', amount: dmg, source: ctx.source });
  },
  reveal_unit: (ctx) => {
    // 强制翻开：不结算「翻开时」效果，且当回合休整（见 revealUnit forced 分支）
    const t = ctx.target;
    if (!t || t === 'player') return; // 已经过 validateEffectTarget 校验
    revealUnit(ctx.state, other(ctx.side), t, ctx.events, true);
  },
  damage_trigger: (ctx, a) => {
    // 埋伏触发：对触发者（攻击单位）造成伤害。ctx.side 为埋伏持有者，触发者在对面
    const t = ctx.triggerRef;
    if (!t) return;
    const u = unitAt(ctx.state, other(ctx.side), t);
    if (!u) return;
    u.hp -= a.amount;
    ctx.events.push({ type: 'damage', player: ctx.side, target: t, amount: a.amount, source: ctx.source });
  },
  self_ready: (ctx) => {
    // 翻开时：自身清除休整、本回合可攻击
    const ref = ctx.selfRef;
    if (!ref) return;
    const u = unitAt(ctx.state, ctx.side, ref);
    if (!u) return;
    u.sick = false;
    u.attacked = false;
  },
};

/** 用对局状态派生种子洗牌，保证可复现（约定：随机只用 createRng） */
function seededShuffle(state: GameState, deck: string[]): void {
  const rng = createRng(state.turn * 10007 + state.uidCounter * 131 + deck.length);
  shuffle(deck, rng);
}

function applyBuff(unit: UnitState, def: CardDef): void {
  const b: AppliedBuff = {
    cardId: def.id,
    name: def.name,
    atk: def.buff?.atk ?? 0,
    hp: def.buff?.hp ?? 0,
    keywords: [...(def.buff?.keywords ?? [])],
    destroyAfterAttack: def.buff?.destroyAfterAttack ?? false,
  };
  unit.atk += b.atk;
  unit.maxHp += b.hp;
  unit.hp += b.hp;
  unit.keywords.push(...b.keywords);
  unit.buffs.push(b);
}

function removeBuff(unit: UnitState, index: number): void {
  const b = unit.buffs[index];
  unit.atk -= b.atk;
  unit.maxHp -= b.hp;
  unit.hp = Math.min(unit.hp, unit.maxHp);
  for (const kw of b.keywords) {
    const i = unit.keywords.indexOf(kw);
    if (i >= 0) unit.keywords.splice(i, 1);
  }
  unit.buffs.splice(index, 1);
}

function attack(
  state: GameState,
  side: PlayerIndex,
  action: Extract<GameAction, { type: 'attack' }>,
  events: GameEvent[],
): Result {
  const attacker = unitAt(state, side, action.attacker);
  if (!attacker) return { ok: false, error: '攻击单位不存在' };
  // 易容单位宣告攻击：先翻开并结算「翻开时」效果（self_ready 会清除休整，使影子刺客当回合可攻击，
  // 与 legalTargets 的 revealReadies 放行保持一致）；
  // 若后续校验不通过，整个动作作废，克隆状态与事件一并丢弃
  if (attacker.faceDown) revealUnit(state, side, action.attacker, events, false);
  if (attacker.sick) return { ok: false, error: '该单位本回合无法行动（召唤失调）' };
  if (attacker.attacked) return { ok: false, error: '该单位本回合已攻击过' };
  const legal = legalTargets(state, side, action.attacker);
  const ok = legal.some((t) =>
    t === 'player' ? action.target === 'player' : action.target !== 'player' && t.row === action.target.row && t.slot === action.target.slot,
  );
  if (!ok) return { ok: false, error: '该目标不可攻击（前排阻挡/护卫限制）' };

  attacker.attacked = true;
  const foe = other(side);

  // 埋伏：防守方第一张 on_opp_attack 陷阱被触发（每次攻击只触发一张）
  const traps = state.players[foe].traps;
  for (let i = 0; i < traps.length; i++) {
    const trapCard = traps[i];
    if (!trapCard) continue;
    const trapDef = CARDS[trapCard];
    if (!trapDef?.trap || trapDef.trap.trigger !== 'on_opp_attack') continue;
    traps[i] = null; // 触发后释放空位
    events.push({ type: 'trap_trigger', player: foe, card: trapCard });
    for (const eff of trapDef.trap.effects) {
      for (const a of eff.actions) {
        (EFFECT_HANDLERS[a.kind] as (ctx: EffectCtx, action: EffectAction) => void)(
          { state, side: foe, triggerRef: action.attacker, source: trapCard, events },
          a,
        );
      }
    }
    break;
  }

  if (action.target === 'player') {
    state.players[foe].hp -= attacker.atk;
    events.push({ type: 'attack', player: side, attacker: action.attacker, target: 'player', damage: attacker.atk });
  } else {
    const defender = unitAt(state, foe, action.target)!;
    // 易容单位被攻击：结算伤害前正常翻开并结算「翻开时」效果
    if (defender.faceDown) revealUnit(state, foe, action.target, events, false);
    defender.hp -= attacker.atk;
    attacker.hp -= defender.atk;
    events.push({
      type: 'attack',
      player: side,
      attacker: action.attacker,
      target: action.target,
      damage: attacker.atk,
      counter: defender.atk,
    });
  }
  // 淬毒类传功：单位攻击后销毁
  for (let i = attacker.buffs.length - 1; i >= 0; i--) {
    if (attacker.buffs[i].destroyAfterAttack) {
      events.push({ type: 'buff_expire', player: side, ref: action.attacker, name: attacker.buffs[i].name });
      removeBuff(attacker, i);
    }
  }
  removeDead(state, events);
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

/** 对手视角下盖放单位的伪装：只保留 uid/sick/attacked 真实值，其余全部隐藏为 1/1 路人 */
function maskUnit(u: UnitState | null): UnitState | null {
  if (!u || !u.faceDown) return u;
  return {
    uid: u.uid,
    cardId: 'facedown',
    name: '路人',
    atk: 1,
    hp: 1,
    maxHp: 1,
    keywords: [],
    sick: u.sick,
    attacked: u.attacked,
    faceDown: true,
    buffs: [],
  };
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
      traps: [...me.traps],
    },
    opp: {
      hp: opp.hp,
      maxHp: opp.maxHp,
      mana: opp.mana,
      maxMana: opp.maxMana,
      handCount: opp.hand.length,
      deckCount: opp.deck.length,
      board: { front: opp.board.front.map(maskUnit), back: opp.board.back.map(maskUnit) },
      fatigue: opp.fatigue,
      trapCount: opp.traps.filter((t) => t !== null).length,
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
 * - 对手盖放易容单位 / 布下埋伏的 play_card 事件抹掉 card 字段
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
      // 对手盖放易容单位 / 布下埋伏：抹掉 card 字段，只保留「盖放了什么类型」的标记
      if (e.type === 'play_card' && e.player !== side && (e.faceDown || e.trap)) {
        const { card: _card, ...rest } = e;
        return rest;
      }
      return e;
    })
    .filter((e) => {
      if (e.type === 'reveal') return e.player === side;
      return true;
    });
}
