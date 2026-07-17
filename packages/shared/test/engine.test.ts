import assert from 'node:assert';
import {
  applyAction,
  botTurn,
  buildStarterDeck,
  CARDS,
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
    board: {
      front: Array.from({ length: 6 }, () => null),
      back: Array.from({ length: 3 }, () => null),
    },
    traps: [null, null, null],
  };
}
function makeState(): GameState {
  return { players: [emptyPlayer(), emptyPlayer()], turn: 1, current: 0, uidCounter: 1, winner: null };
}
function makeUnit(cardId: string, atk: number, hp: number, keywords: UnitState['keywords'] = []): UnitState {
  return { uid: 99, cardId, name: cardId, atk, hp, maxHp: hp, keywords, sick: false, attacked: false, faceDown: false, buffs: [] };
}

// ---------- 测试 ----------
console.log('规则引擎单元测试');

test('开局：先手 3 张、后手 4 张，先手行动；首回合计为第 1 回合且先手 1 点内力', () => {
  const s = createGame(buildStarterDeck(), buildStarterDeck(), 42);
  assert.equal(s.players[0].hand.length, 3);
  assert.equal(s.players[1].hand.length, 4);
  assert.equal(s.current, 0);
  assert.equal(s.winner, null);
  assert.equal(s.turn, 1, '首回合应计为第 1 回合');
  assert.equal(s.players[0].mana, 1, '先手首回合应有 1 点内力');
  assert.equal(s.players[0].maxMana, 1);
  assert.equal(s.players[1].mana, 0, '后手未行动前无内力');
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

test('战场：前锋 6 格、后营 3 格，超出格子不能部署', () => {
  const s = createGame(buildStarterDeck(), buildStarterDeck(), 42);
  assert.equal(s.players[0].board.front.length, 6);
  assert.equal(s.players[0].board.back.length, 3);
  const s2 = makeState();
  s2.players[0].hand = ['veteran_cop'];
  const r = applyAction(s2, 0, { type: 'play_card', handIndex: 0, row: 'back', slot: 3 });
  assert.ok(!r.ok);
});

test('卡池：衍生牌（蛊奴）不进预组卡组，且每单位恰有一个攻击范围关键词', () => {
  const deck = buildStarterDeck();
  assert.ok(!deck.includes('gu_slave'));
  for (const def of Object.values(CARDS)) {
    if (def.kind !== 'unit') continue;
    const range = (def.keywords ?? []).filter((k) => k === 'melee' || k === 'ranged');
    assert.equal(range.length, 1, `${def.id} 必须恰有一个 melee/ranged`);
  }
});

test('传功：护法传功 +1/+2 贴附友方单位；空位/无目标被拒绝', () => {
  const s = makeState();
  s.players[0].hand = ['hufa_chuangong', 'hufa_chuangong'];
  s.players[0].board.front[0] = makeUnit('veteran_cop', 4, 3);
  // 无目标 / 目标空位都应拒绝
  assert.ok(!applyAction(s, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 0 }).ok);
  assert.ok(!applyAction(s, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 0, target: { row: 'front', slot: 1 } }).ok);
  // target 指向自己棋盘对应单位
  const r = applyAction(s, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 0, target: { row: 'front', slot: 0 } });
  assert.ok(r.ok);
  const u = r.state.players[0].board.front[0]!;
  assert.equal(u.atk, 5);
  assert.equal(u.hp, 5);
  assert.equal(u.maxHp, 5);
  assert.equal(u.buffs.length, 1);
});

test('淬毒：淬毒短刃 +2 攻，单位攻击后销毁并回落', () => {
  const s = makeState();
  s.players[0].hand = ['qudu_blade'];
  s.players[0].board.front[0] = makeUnit('veteran_cop', 4, 3);
  const r1 = ok(applyAction(s, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 0, target: { row: 'front', slot: 0 } }));
  assert.equal(r1.state.players[0].board.front[0]!.atk, 6);
  const r2 = ok(applyAction(r1.state, 0, { type: 'attack', attacker: { row: 'front', slot: 0 }, target: 'player' }));
  const u = r2.state.players[0].board.front[0]!;
  assert.equal(u.atk, 4, '攻击后毒刃销毁，攻回落');
  assert.equal(u.buffs.length, 0);
  assert.ok(r2.events.some((e) => e.type === 'buff_expire'));
  assert.equal(r2.state.players[1].hp, 30 - 6, '本次攻击按 +2 后的攻击力结算');
});

test('下毒/驱毒：蛊毒散洗 2 张蛊奴进对手牌库，清心诀全部移除', () => {
  const s = makeState();
  s.players[0].hand = ['gu_powder'];
  s.players[1].deck = ['veteran_cop', 'sniper'];
  const r1 = ok(applyAction(s, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 0 }));
  const foeDeck = r1.state.players[1].deck;
  assert.equal(foeDeck.length, 4);
  assert.equal(foeDeck.filter((c) => c === 'gu_slave').length, 2);
  // 对手回合打出清心诀驱毒
  const r2 = ok(applyAction(r1.state, 0, { type: 'end_turn' }));
  r2.state.players[1].hand = ['qingxin_jue'];
  r2.state.players[1].mana = 10;
  const r3 = ok(applyAction(r2.state, 1, { type: 'play_card', handIndex: 0, row: 'front', slot: 0 }));
  assert.equal(r3.state.players[1].deck.filter((c) => c === 'gu_slave').length, 0);
  const purify = r3.events.find((e) => e.type === 'purify');
  assert.ok(purify && (purify.removed as number) >= 2);
});

test('万蛊噬心：对手牌库每张蛊奴造成 1 点伤害', () => {
  const s = makeState();
  s.players[0].hand = ['wan_gu_devour'];
  s.players[1].deck = ['gu_slave', 'gu_slave', 'gu_slave', 'veteran_cop'];
  const r = ok(applyAction(s, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 0 }));
  assert.equal(r.state.players[1].hp, 27);
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

test('易容与 legalTargets 一致：self_ready 单位休整中也有合法目标，普通单位没有', () => {
  const s = makeState();
  s.players[0].hand = ['shadow_assassin', 'veteran_cop'];
  const r = ok(applyAction(s, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 0 }));
  // 影子刺客：盖放且休整，但翻开即 self_ready → 有合法目标
  assert.ok(legalTargets(r.state, 0, { row: 'front', slot: 0 }).length > 0);
  // 普通单位休整中 → 无合法目标
  const r2 = ok(applyAction(r.state, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 1 }));
  assert.equal(legalTargets(r2.state, 0, { row: 'front', slot: 1 }).length, 0);
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

test('易容：盖放打出，对手视角伪装为 1/1 路人，自己视角为真实数值', () => {
  const s = makeState();
  s.players[0].hand = ['shadow_assassin'];
  const r = ok(applyAction(s, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 0 }));
  assert.equal(r.state.players[0].board.front[0]!.faceDown, true);
  // 对手视角：伪装为路人
  const oppUnit = getView(r.state, 1).opp.board.front[0]!;
  assert.equal(oppUnit.cardId, 'facedown');
  assert.equal(oppUnit.name, '路人');
  assert.equal(oppUnit.atk, 1);
  assert.equal(oppUnit.hp, 1);
  assert.equal(oppUnit.maxHp, 1);
  assert.equal(oppUnit.keywords.length, 0);
  assert.equal(oppUnit.buffs.length, 0);
  assert.equal(oppUnit.faceDown, true);
  // 自己视角：真实 4/3
  const myUnit = getView(r.state, 0).me.board.front[0]!;
  assert.equal(myUnit.cardId, 'shadow_assassin');
  assert.equal(myUnit.atk, 4);
  assert.equal(myUnit.hp, 3);
  assert.ok(myUnit.keywords.includes('stealth'));
});

test('信息泄露：对手收到的 play_card 事件不含 card 字段（易容盖放与埋伏）', () => {
  const s = makeState();
  s.players[0].hand = ['shadow_assassin', 'fudao_trap'];
  const r1 = ok(applyAction(s, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 0 }));
  const r2 = ok(applyAction(r1.state, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 0 }));
  // 自己视角仍能看到具体内容
  assert.ok(filterEventsFor(r1.events, 0).some((e) => e.type === 'play_card' && e.card === 'shadow_assassin'));
  assert.ok(filterEventsFor(r2.events, 0).some((e) => e.type === 'play_card' && e.card === 'fudao_trap'));
  // 对手视角：card 被抹掉，只保留盖放/埋伏标记
  const oppPlay1 = filterEventsFor(r1.events, 1).find((e) => e.type === 'play_card')!;
  assert.ok(!('card' in oppPlay1));
  assert.equal(oppPlay1.faceDown, true);
  const oppPlay2 = filterEventsFor(r2.events, 1).find((e) => e.type === 'play_card')!;
  assert.ok(!('card' in oppPlay2));
  assert.equal(oppPlay2.trap, true);
});

test('易容翻开：打出当回合宣告攻击，翻开且 self_ready 生效（按真实 4 攻结算）', () => {
  const s = makeState();
  s.players[0].hand = ['shadow_assassin'];
  const r1 = ok(applyAction(s, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 0 }));
  assert.equal(r1.state.players[0].board.front[0]!.sick, true, '打出当回合处于休整');
  const r2 = ok(applyAction(r1.state, 0, { type: 'attack', attacker: { row: 'front', slot: 0 }, target: 'player' }));
  const u = r2.state.players[0].board.front[0]!;
  assert.equal(u.faceDown, false, '攻击时翻开');
  assert.equal(u.attacked, true);
  assert.equal(r2.state.players[1].hp, 30 - 4, '按真实攻击力 4 结算');
  const reveal = r2.events.find((e) => e.type === 'unit_reveal');
  assert.ok(reveal && reveal.card === 'shadow_assassin' && !reveal.forced);
});

test('照妖镜：强制翻开易容单位，不触发「翻开时」且当回合休整', () => {
  const s = makeState();
  s.players[0].hand = ['shadow_assassin'];
  s.players[1].hand = ['zhaoyaojing'];
  const r1 = ok(applyAction(s, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 0 }));
  const r2 = ok(applyAction(r1.state, 0, { type: 'end_turn' }));
  const r3 = ok(applyAction(r2.state, 1, { type: 'play_card', handIndex: 0, row: 'front', slot: 0, target: { row: 'front', slot: 0 } }));
  const u = r3.state.players[0].board.front[0]!;
  assert.equal(u.faceDown, false);
  assert.equal(u.sick, true, '被识破当回合休整（self_ready 未触发，否则 sick 会被清除）');
  const reveal = r3.events.find((e) => e.type === 'unit_reveal');
  assert.ok(reveal && reveal.card === 'shadow_assassin' && reveal.forced === true);
  // 目标不是易容单位时报错
  const s2 = makeState();
  s2.current = 1;
  s2.players[1].hand = ['zhaoyaojing'];
  s2.players[0].board.front[0] = makeUnit('veteran_cop', 4, 3);
  const bad = applyAction(s2, 1, { type: 'play_card', handIndex: 0, row: 'front', slot: 0, target: { row: 'front', slot: 0 } });
  assert.ok(!bad.ok && bad.error === '目标不是易容单位');
});

test('埋伏：敌方单位宣告攻击时触发伏刀阵，攻击单位受 3 伤并释放空位', () => {
  const s = makeState();
  s.players[0].deck = ['sniper'];
  s.players[1].deck = ['sniper']; // 避免空牌库疲劳干扰血量断言
  s.players[1].hand = ['fudao_trap'];
  s.players[0].board.front[0] = makeUnit('veteran_cop', 4, 5);
  let r = ok(applyAction(s, 0, { type: 'end_turn' }));
  r = ok(applyAction(r.state, 1, { type: 'play_card', handIndex: 0, row: 'front', slot: 0 }));
  assert.deepEqual(r.state.players[1].traps, ['fudao_trap', null, null]);
  assert.ok(r.events.some((e) => e.type === 'play_card' && e.trap === true));
  r = ok(applyAction(r.state, 1, { type: 'end_turn' }));
  r = ok(applyAction(r.state, 0, { type: 'attack', attacker: { row: 'front', slot: 0 }, target: 'player' }));
  const u = r.state.players[0].board.front[0]!;
  assert.equal(u.hp, 5 - 3, '触发者（攻击单位）受到 3 点伤害');
  assert.deepEqual(r.state.players[1].traps, [null, null, null], '触发后释放埋伏空位');
  // trap_trigger 事件双方可见
  assert.ok(filterEventsFor(r.events, 0).some((e) => e.type === 'trap_trigger' && e.card === 'fudao_trap'));
  assert.ok(filterEventsFor(r.events, 1).some((e) => e.type === 'trap_trigger' && e.card === 'fudao_trap'));
  // 攻击本身仍然结算（打脸 4 点）
  assert.equal(r.state.players[1].hp, 30 - 4);
});

test('视角：me.traps 是 cardId 数组，opp.trapCount 只是数量', () => {
  const s = makeState();
  s.players[0].hand = ['fudao_trap'];
  const r = ok(applyAction(s, 0, { type: 'play_card', handIndex: 0, row: 'front', slot: 0 }));
  const v0 = getView(r.state, 0);
  assert.deepEqual(v0.me.traps, ['fudao_trap', null, null]);
  assert.equal(v0.opp.trapCount, 0);
  const v1 = getView(r.state, 1);
  assert.equal(v1.opp.trapCount, 1);
  assert.ok(!('traps' in v1.opp));
});

console.log(`\n全部 ${passed} 个测试通过 ✅`);
