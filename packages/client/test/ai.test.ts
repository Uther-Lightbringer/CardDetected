import assert from 'node:assert';
import type { GameState, PlayerState, UnitState } from '@cardetect/shared';
import { buildPrompt, parseModelResponse, resolveAiAction } from '../src/ai/deepseek';

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
    hp: 30, maxHp: 30, mana: 5, maxMana: 5,
    deck: [], hand: [], fatigue: 0,
    board: { front: [null, null, null], back: [null, null, null] },
  };
}
function makeState(): GameState {
  return { players: [emptyPlayer(), emptyPlayer()], turn: 5, current: 1, uidCounter: 1, winner: null };
}
function makeUnit(cardId: string, atk: number, hp: number, keywords: UnitState['keywords'] = []): UnitState {
  return { uid: 1, cardId, name: cardId, atk, hp, maxHp: hp, keywords, sick: false, attacked: false };
}

console.log('Deepseek AI 模块测试');

// ---------- parseModelResponse ----------
test('解析：干净的 JSON（含台词）', () => {
  const r = parseModelResponse('{"comment":"线索指向你了","actions":[{"type":"end_turn"}]}');
  assert.equal(r?.comment, '线索指向你了');
  assert.equal(r?.actions.length, 1);
});

test('解析：带 markdown 围栏和前后废话', () => {
  const r = parseModelResponse('好的，我的回合：\n```json\n{"actions":[{"type":"attack","attacker":{"row":"front","slot":0},"target":"player"},{"type":"end_turn"}]}\n```\n希望没算错');
  assert.equal(r?.actions.length, 2);
  assert.equal(r?.comment, undefined);
});

test('解析：垃圾文本返回 null', () => {
  assert.equal(parseModelResponse('我不知道怎么玩'), null);
  assert.equal(parseModelResponse('{"foo":1}'), null);
});

test('解析：超长台词截断到 60 字', () => {
  const long = '长'.repeat(100);
  const r = parseModelResponse(`{"comment":"${long}","actions":[{"type":"end_turn"}]}`);
  assert.equal(r?.comment?.length, 60);
});

// ---------- resolveAiAction ----------
test('翻译：卡牌名解析为当前 handIndex', () => {
  const s = makeState();
  s.players[1].hand = ['sniper', 'veteran_cop'];
  const ga = resolveAiAction({ type: 'play_card', card: '老练刑警' }, s, 1);
  assert.deepEqual(ga, { type: 'play_card', handIndex: 1, row: 'front', slot: 0 });
});

test('翻译：远程单位默认放后排', () => {
  const s = makeState();
  s.players[1].hand = ['sniper'];
  const ga = resolveAiAction({ type: 'play_card', card: '狙击手' }, s, 1);
  assert.deepEqual(ga, { type: 'play_card', handIndex: 0, row: 'back', slot: 0 });
});

test('翻译：指定位置被占时自动找空位', () => {
  const s = makeState();
  s.players[1].hand = ['veteran_cop'];
  s.players[1].board.front[0] = makeUnit('rookie_detective', 2, 1);
  const ga = resolveAiAction({ type: 'play_card', card: '老练刑警', row: 'front', slot: 0 }, s, 1);
  assert.deepEqual(ga, { type: 'play_card', handIndex: 0, row: 'front', slot: 1 });
});

test('翻译：整排占满返回 null', () => {
  const s = makeState();
  s.players[1].hand = ['veteran_cop'];
  s.players[1].board.front = [makeUnit('a', 1, 1), makeUnit('b', 1, 1), makeUnit('c', 1, 1)];
  assert.equal(resolveAiAction({ type: 'play_card', card: '老练刑警' }, s, 1), null);
});

test('翻译：不存在的卡牌名返回 null', () => {
  const s = makeState();
  s.players[1].hand = ['sniper'];
  assert.equal(resolveAiAction({ type: 'play_card', card: '不存在的牌' }, s, 1), null);
});

test('翻译：伤害法术必须带敌方单位目标', () => {
  const s = makeState();
  s.players[1].hand = ['interrogation'];
  assert.equal(resolveAiAction({ type: 'play_card', card: '审讯' }, s, 1), null);
  const ga = resolveAiAction({ type: 'play_card', card: '审讯', target: { row: 'front', slot: 2 } }, s, 1);
  assert.ok(ga && ga.type === 'play_card' && ga.handIndex === 0);
});

test('翻译：抽牌法术无需目标；兼容旧 handIndex 格式', () => {
  const s = makeState();
  s.players[1].hand = ['gather_clues', 'sniper'];
  const ga = resolveAiAction({ type: 'play_card', handIndex: 0 }, s, 1);
  assert.deepEqual(ga, { type: 'play_card', handIndex: 0, row: 'front', slot: 0 });
});

test('翻译：攻击与结束回合直通', () => {
  const s = makeState();
  assert.deepEqual(resolveAiAction({ type: 'end_turn' }, s, 1), { type: 'end_turn' });
  const atk = resolveAiAction({ type: 'attack', attacker: { row: 'front', slot: 0 }, target: 'player' }, s, 1);
  assert.equal(atk?.type, 'attack');
});

// ---------- buildPrompt ----------
test('prompt：手牌标注费用是否足够', () => {
  const s = makeState();
  s.players[1].mana = 2;
  s.players[1].hand = ['sniper', 'swat_captain']; // 2费够 / 5费不够
  const p = buildPrompt(s, 1, []);
  assert.ok(p.includes('★狙击手'));
  assert.ok(p.includes('✩重案组长'));
});

test('prompt：远程单位的合法目标包含对方玩家', () => {
  const s = makeState();
  s.players[1].board.back[1] = makeUnit('sniper', 2, 1, ['ranged']);
  s.players[0].board.front[0] = makeUnit('veteran_cop', 4, 3);
  const p = buildPrompt(s, 1, []);
  assert.ok(p.includes('你的后排[1]sniper(攻2)'));
  assert.ok(p.includes('对方玩家'));
  assert.ok(p.includes('敌方前排[0]veteran_cop'));
});

test('prompt：近战被前排挡住时不提供打脸选项；含最近战况', () => {
  const s = makeState();
  s.players[1].board.front[0] = makeUnit('veteran_cop', 4, 3);
  s.players[0].board.front[0] = makeUnit('rookie_detective', 2, 1);
  const p = buildPrompt(s, 1, ['T4', '对手打出「狙击手」']);
  const attackLine = p.split('\n').find((l) => l.includes('你的前排[0]'))!;
  assert.ok(!attackLine.includes('对方玩家'));
  assert.ok(p.includes('对手打出「狙击手」'));
});

console.log(`\n全部 ${passed} 个测试通过 ✅`);
