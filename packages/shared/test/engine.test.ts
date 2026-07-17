import assert from 'node:assert';
import {
  applyAction,
  botTurn,
  buildStarterDeck,
  createGame,
  filterEventsFor,
  getView,
  legalTargets,
  type GameState,
  type PlayerState,
  type UnitState,
} from '../src/index.js';

type ApplyResult = ReturnType<typeof applyAction>;
function ok(r: ApplyResult): Extract<ApplyResult, { ok: true }> {
  if (!r.ok) throw new Error(`动作应成功但被拒绝: ${r.error}`);
  return r;
}

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

// ---------- 工具 ----------
function emptyPlayer(): PlayerState {
  return {
    hp: 30, maxHp: 30, mana: 10, maxMana: 10,
    deck: [], hand: [], fatigue: 0,
    board: { front: [null, null, null], back: [null, null, null] },
  };
}
function makeState(): GameState {
  return { players: [emptyPlayer(), emptyPlayer()], turn: 1, current: 0, uidCounter: 1, winner: null };
}
function makeUnit(cardId: string, atk: number, hp: number, keywords: UnitState['keywords'] = []): UnitState {
  return { uid: 99, cardId, name: cardId, atk, hp, maxHp: hp, keywords, sick: false, attacked: false };
}

// ---------- 测试 ----------
console.log('规则引擎单元测试');

test('开局：先手 3 张、后手 4 张，先手行动', () => {
  const s = createGame(buildStarterDeck(), buildStarterDeck(), 42);
  assert.equal(s.players[0].hand.length, 3);
  assert.equal(s.players[1].hand.length, 4);
  assert.equal(s.current, 0);
  assert.equal(s.winner, null);
});

test('结束回合：切换到对手，法力+1 并抽牌', () => {
  const s = createGame(buildStarterDeck(), buildStarterDeck(), 42);
  const r = applyAction(s, 0, { type: 'end_turn' });
  assert.ok(r.ok);
  assert.equal(r.state.current, 1);
  assert.equal(r.state.players[1].maxMana, 1);
  assert.equal(r.state.players[1].hand.length, 5); // 4 + 回合抽 1
  // 原 state 不被修改（纯函数式）
  assert.equal(s.current, 0);
});

test('非当前方不能行动', () => {
  const s = makeState();
  const r = applyAction(s, 1, { type: 'end_turn' });
  assert.ok(!r.ok);
});

test('近战被敌方前排阻挡时不能打脸', () => {
  const s = makeState();
  s.players[0].board.front[0] = makeUnit('veteran_cop', 4, 3);
  s.players[1].board.front[0] = makeUnit('rookie_detective', 2, 1);
  const targets = legalTargets(s, 0, { row: 'front', slot: 0 });
  assert.ok(!targets.includes('player'));
  assert.ok(targets.some((t) => t !== 'player' && t.row === 'front'));
  // 非法目标应被 applyAction 拒绝
  const r = applyAction(s, 0, { type: 'attack', attacker: { row: 'front', slot: 0 }, target: 'player' });
  assert.ok(!r.ok);
});

test('敌方前排清空后近战可以打脸', () => {
  const s = makeState();
  s.players[0].board.front[0] = makeUnit('veteran_cop', 4, 3);
  const targets = legalTargets(s, 0, { row: 'front', slot: 0 });
  assert.ok(targets.includes('player'));
});

test('远程无视前排阻挡直接打脸', () => {
  const s = makeState();
  s.players[0].board.back[0] = makeUnit('sniper', 2, 1, ['ranged']);
  s.players[1].board.front[0] = makeUnit('rookie_detective', 2, 1);
  const targets = legalTargets(s, 0, { row: 'back', slot: 0 });
  assert.ok(targets.includes('player'));
});

test('护卫（嘲讽）强制优先攻击', () => {
  const s = makeState();
  s.players[0].board.back[0] = makeUnit('sniper', 2, 1, ['ranged']);
  s.players[1].board.front[0] = makeUnit('swat_captain', 5, 6, ['guard']);
  const targets = legalTargets(s, 0, { row: 'back', slot: 0 });
  assert.deepEqual(targets, [{ row: 'front', slot: 0 }]);
});

test('渗透无视前排阻挡', () => {
  const s = makeState();
  s.players[0].board.front[0] = makeUnit('undercover_agent', 4, 4, ['infiltrate']);
  s.players[1].board.front[0] = makeUnit('rookie_detective', 2, 1);
  const targets = legalTargets(s, 0, { row: 'front', slot: 0 });
  assert.ok(targets.includes('player'));
});

test('打出单位：扣法力、占格、召唤失调；速攻除外', () => {
  const s = makeState();
  s.players[0].mana = 10;
  s.players[0].hand = ['veteran_cop', 'assault_team'];
  const r1 = applyAction(s, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 0 });
  assert.ok(r1.ok);
  assert.equal(r1.state.players[0].mana, 7);
  assert.equal(r1.state.players[0].board.front[0]?.sick, true);
  // 召唤失调不能攻击
  assert.equal(legalTargets(r1.state, 0, { row: 'front', slot: 0 }).length, 0);
  // 速攻单位当回合可攻击
  const r2 = applyAction(r1.state, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 1 });
  assert.ok(r2.ok);
  assert.ok(legalTargets(r2.state, 0, { row: 'front', slot: 1 }).length > 0);
});

test('法力不足不能出牌', () => {
  const s = makeState();
  s.players[0].mana = 1;
  s.players[0].hand = ['swat_captain'];
  const r = applyAction(s, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 0 });
  assert.ok(!r.ok);
});

test('法术-审讯：造成 3 点伤害并结算死亡', () => {
  const s = makeState();
  s.players[0].hand = ['interrogation'];
  s.players[1].board.front[0] = makeUnit('rookie_detective', 2, 1);
  const r = applyAction(s, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 0, target: { row: 'front', slot: 0 } });
  assert.ok(r.ok);
  assert.equal(r.state.players[1].board.front[0], null);
  assert.ok(r.events.some((e) => e.type === 'death'));
});

test('单位互殴：双方同时结算伤害', () => {
  const s = makeState();
  s.players[0].board.front[0] = makeUnit('veteran_cop', 4, 3);
  s.players[1].board.front[0] = makeUnit('street_informer', 3, 2);
  const r = applyAction(s, 0, { type: 'attack', attacker: { row: 'front', slot: 0 }, target: { row: 'front', slot: 0 } });
  assert.ok(r.ok);
  // 4/3 挨 3 点反击也是 0 血，双方同归于尽
  assert.equal(r.state.players[1].board.front[0], null);
  assert.equal(r.state.players[0].board.front[0], null);
  assert.equal(r.events.filter((e) => e.type === 'death').length, 2);
});

test('疲劳：牌库空了抽牌掉血，且伤害递增', () => {
  const s = makeState();
  s.players[0].deck = [];
  s.players[1].hand = [];
  let r = ok(applyAction(s, 0, { type: 'end_turn' }));
  r = ok(applyAction(r.state, 1, { type: 'end_turn' })); // 回到 P0，抽牌疲劳 1
  assert.equal(r.state.players[0].hp, 29);
  r = ok(applyAction(r.state, 0, { type: 'end_turn' }));
  r = ok(applyAction(r.state, 1, { type: 'end_turn' })); // 疲劳 2
  assert.equal(r.state.players[0].hp, 27);
});

test('侦测：reveal 事件只有施放者可见，对手抽牌不泄露内容', () => {
  const s = createGame(buildStarterDeck(), buildStarterDeck(), 7);
  s.players[0].hand = ['crime_scene_scan'];
  s.players[0].mana = 10;
  const r = applyAction(s, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 0 });
  assert.ok(r.ok);
  const reveal = r.events.find((e) => e.type === 'reveal');
  assert.ok(reveal && Array.isArray(reveal.hand));
  const mine = filterEventsFor(r.events, 0);
  const theirs = filterEventsFor(r.events, 1);
  assert.ok(mine.some((e) => e.type === 'reveal'));
  assert.ok(!theirs.some((e) => e.type === 'reveal'));
  // 对手视角的 draw 事件不含卡牌内容
  const r2 = applyAction(r.state, 0, { type: 'end_turn' });
  assert.ok(r2.ok);
  const oppDraw = filterEventsFor(r2.events, 0).find((e) => e.type === 'draw' && e.player === 1);
  assert.ok(oppDraw && !('cards' in oppDraw));
});

test('视角：对手手牌只有数量，没有内容', () => {
  const s = createGame(buildStarterDeck(), buildStarterDeck(), 1);
  const v = getView(s, 0);
  assert.equal(typeof v.opp.handCount, 'number');
  assert.ok(!('hand' in v.opp));
  assert.equal(v.me.hand.length, 3);
});

test('机器人对打：能完整打完一局并分出胜负', () => {
  let s = createGame(buildStarterDeck(), buildStarterDeck(), 12345);
  let guard = 0;
  while (s.winner === null && guard < 300) {
    const side = s.current;
    for (const action of botTurn(s, side)) {
      if (s.winner !== null) break; // 战斗中途可能已分出胜负，剩余动作作废
      const r = applyAction(s, side, action);
      assert.ok(r.ok, `机器人动作应合法: ${JSON.stringify(action)} -> ${r.ok ? '' : (r as { error: string }).error}`);
      if (r.ok) s = r.state;
    }
    guard++;
  }
  assert.notEqual(s.winner, null, '300 个动作内应分出胜负');
  console.log(`    → 共 ${s.turn} 回合，胜方 P${s.winner}，剩余血量 P0=${s.players[0].hp} P1=${s.players[1].hp}`);
});

console.log(`\n全部 ${passed} 个测试通过 ✅`);
