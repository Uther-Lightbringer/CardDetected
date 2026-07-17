import { CARDS } from './cards.js';
import { applyAction, BOARD_SLOTS, legalTargets, unitAt } from './engine.js';
import type { GameAction, GameState, PlayerIndex, TargetRef, UnitRef } from './types.js';

/**
 * 内置机器人：贪心策略。
 * 1. 尽可能打出法力够的牌（优先高费；远程放后排，近战放前排）
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
      const eff = def.effect!;
      if (eff.kind === 'damage') {
        const target = bestDamageTarget(sim, side, eff.amount);
        if (!target) continue;
        const action: GameAction = { type: 'play_card', handIndex: i, row: 'front', slot: 0, target };
        if (applySim(action)) {
          playActions.push(action);
          played = true;
        }
        break;
      }
      // draw / reveal_hand
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
    for (let slot = 0; slot < BOARD_SLOTS; slot++) {
      const ref: UnitRef = { row, slot };
      const u = unitAt(sim, side, ref);
      if (!u || u.sick || u.attacked) continue;
      const targets = legalTargets(sim, side, ref);
      if (targets.length === 0) continue;
      const target = pickTarget(sim, side, targets);
      const action: GameAction = { type: 'attack', attacker: ref, target };
      if (applySim(action)) attackActions.push(action);
    }
  }

  return [...playActions, ...attackActions, { type: 'end_turn' }];
}

/** 选一个"审讯"目标：能打死的最贵单位，否则攻最高的 */
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
