import { CARDS } from './cards.js';
import { applyAction, legalTargets, unitAt } from './engine.js';
import type { GameAction, GameState, PlayerIndex, TargetRef, UnitRef } from './types.js';

/**
 * 内置机器人：贪心策略。
 * 1. 尽可能打出内力够的牌（优先高费；远程放后营，近战放前锋；传功贴给攻最高的友方单位）
 * 2. 每个可行动单位攻击一次（有护卫必须先解，否则优先打脸）
 * 单人模式的本地对手，也是大模型失灵时的兜底。
 */
export function botTurn(state: GameState, side: PlayerIndex): GameAction[] {
  const playActions: GameAction[] = [];
  const attackActions: GameAction[] = [];
  const sim = structuredClone(state); // 在克隆上模拟，保证手牌序号/法力消耗连续正确

  const applySim = (action: GameAction): boolean => {
    const r = applyAction(sim, side, action);
    if (!r.ok) return false;
    Object.assign(sim, r.state);
    return true;
  };

  // ---- 出牌阶段 ----
  let played = true;
  while (played) {
    played = false;
    const me = sim.players[side];
    // 按费用从高到低尝试
    const order = me.hand
      .map((cardId, i) => ({ i, def: CARDS[cardId] }))
      .filter((x) => x.def && x.def.cost <= me.mana)
      .sort((a, b) => b.def!.cost - a.def!.cost);
    for (const { i, def } of order) {
      if (!def) continue;
      if (def.kind === 'unit') {
        const row = (def.keywords ?? []).includes('ranged') ? ('back' as const) : ('front' as const);
        const slot = sim.players[side].board[row].findIndex((x) => x === null);
        if (slot === -1) continue;
        const action: GameAction = { type: 'play_card', handIndex: i, row, slot };
        if (applySim(action)) {
          playActions.push(action);
          played = true;
        }
        break; // handIndex 已变化，重新扫描
      }
      if (def.kind === 'trap') {
        // 埋伏牌：无需目标，直接打出
        const action: GameAction = { type: 'play_card', handIndex: i, row: 'front', slot: 0 };
        if (applySim(action)) {
          playActions.push(action);
          played = true;
        }
        break;
      }
      if (def.kind === 'buff') {
        const target = bestBuffTarget(sim, side);
        if (!target) continue;
        const action: GameAction = { type: 'play_card', handIndex: i, row: 'front', slot: 0, target };
        if (applySim(action)) {
          playActions.push(action);
          played = true;
        }
        break;
      }
      // 法术牌
      const reveal = (def.effects ?? []).flatMap((e) => e.actions).some((a) => a.kind === 'reveal_unit');
      if (reveal) {
        // 识破类法术：选对手第一个盖放单位为目标；没有则不打出
        const target = firstFaceDownUnit(sim, side);
        if (!target) continue;
        const action: GameAction = { type: 'play_card', handIndex: i, row: 'front', slot: 0, target };
        if (applySim(action)) {
          playActions.push(action);
          played = true;
        }
        break;
      }
      const dmg = (def.effects ?? []).flatMap((e) => e.actions).find((a) => a.kind === 'damage');
      if (dmg && dmg.kind === 'damage') {
        const target = bestDamageTarget(sim, side, dmg.amount);
        if (!target) continue;
        const action: GameAction = { type: 'play_card', handIndex: i, row: 'front', slot: 0, target };
        if (applySim(action)) {
          playActions.push(action);
          played = true;
        }
        break;
      }
      // 无目标法术（抽牌 / 识破 / 下毒 / 驱毒等）
      const action: GameAction = { type: 'play_card', handIndex: i, row: 'front', slot: 0 };
      if (applySim(action)) {
        playActions.push(action);
        played = true;
      }
      break;
    }
  }

  // ---- 战斗阶段 ----
  for (const row of ['front', 'back'] as const) {
    for (let slot = 0; slot < sim.players[side].board[row].length; slot++) {
      const ref: UnitRef = { row, slot };
      const u = unitAt(sim, side, ref);
      if (!u || u.attacked) continue; // 休整由 legalTargets 过滤（带 self_ready 的易容单位除外）
      const targets = legalTargets(sim, side, ref);
      if (targets.length === 0) continue;
      const target = pickTarget(sim, side, targets);
      const action: GameAction = { type: 'attack', attacker: ref, target };
      if (applySim(action)) attackActions.push(action);
    }
  }

  return [...playActions, ...attackActions, { type: 'end_turn' }];
}

/** 找对手场上第一个盖放（易容）单位；没有则返回 null */
function firstFaceDownUnit(state: GameState, side: PlayerIndex): UnitRef | null {
  const foe: PlayerIndex = side === 0 ? 1 : 0;
  for (const row of ['front', 'back'] as const) {
    for (let slot = 0; slot < state.players[foe].board[row].length; slot++) {
      if (state.players[foe].board[row][slot]?.faceDown) return { row, slot };
    }
  }
  return null;
}

/** 选一个传功/淬毒目标：攻最高的友方单位 */
function bestBuffTarget(state: GameState, side: PlayerIndex): UnitRef | null {
  let best: { ref: UnitRef; atk: number } | null = null;
  for (const row of ['front', 'back'] as const) {
    state.players[side].board[row].forEach((u, slot) => {
      if (u && (!best || u.atk > best.atk)) best = { ref: { row, slot }, atk: u.atk };
    });
  }
  return best ? (best as { ref: UnitRef; atk: number }).ref : null;
}

/** 选一个"袖里剑"目标：能打死的最贵单位，否则攻最高的 */
function bestDamageTarget(state: GameState, side: PlayerIndex, amount: number): TargetRef | null {
  const foe: PlayerIndex = side === 0 ? 1 : 0;
  const units: { ref: UnitRef; atk: number; hp: number; cost: number }[] = [];
  for (const row of ['front', 'back'] as const) {
    state.players[foe].board[row].forEach((u, slot) => {
      if (u) units.push({ ref: { row, slot }, atk: u.atk, hp: u.hp, cost: CARDS[u.cardId]?.cost ?? 0 });
    });
  }
  if (units.length === 0) return null;
  const killable = units.filter((u) => u.hp <= amount).sort((a, b) => b.cost - a.cost);
  if (killable.length > 0) return killable[0].ref;
  return units.sort((a, b) => b.atk - a.atk)[0].ref;
}

/** 攻击目标优先级：护卫 > 打脸 > 其他单位 */
function pickTarget(state: GameState, side: PlayerIndex, targets: TargetRef[]): TargetRef {
  const foe: PlayerIndex = side === 0 ? 1 : 0;
  const unitTargets = targets.filter((t): t is UnitRef => t !== 'player');
  const guards = unitTargets.filter((t) => unitAt(state, foe, t)?.keywords.includes('guard'));
  if (guards.length > 0) return guards[0];
  if (targets.includes('player')) return 'player';
  return unitTargets[0] ?? 'player';
}
