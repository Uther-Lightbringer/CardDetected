import assert from 'node:assert';
import { validateDeck } from '@cardetect/shared';
import {
  createSave,
  defaultDeck,
  deleteSave,
  loadSaves,
  pushHistory,
  updateSave,
  type StorageLike,
} from '../src/saves';

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

/** 每个用例一份干净的内存存储 */
function mockStorage(): StorageLike {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

console.log('本地存档模块测试');

test('新建存档：自带合法默认牌组并被持久化', () => {
  const s = mockStorage();
  const p = createSave('小明', 'avatar_3', s);
  assert.equal(p.name, '小明');
  assert.equal(p.decks.length, 1);
  assert.equal(validateDeck(p.decks[0].cards), null);
  assert.equal(p.defaultDeckId, p.decks[0].id);
  assert.equal(p.activeGame, null);
  const loaded = loadSaves(s);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, p.id);
});

test('多存档互不干扰；updateSave 按 id 覆盖', () => {
  const s = mockStorage();
  const a = createSave('存档A', 'avatar_1', s);
  createSave('存档B', 'avatar_2', s);
  assert.equal(loadSaves(s).length, 2);
  a.name = '改名了';
  updateSave(a, s);
  const loaded = loadSaves(s);
  assert.equal(loaded.find((x) => x.id === a.id)?.name, '改名了');
  assert.equal(loaded.length, 2);
});

test('删除存档', () => {
  const s = mockStorage();
  const a = createSave('A', 'avatar_1', s);
  const b = createSave('B', 'avatar_2', s);
  deleteSave(a.id, s);
  const loaded = loadSaves(s);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, b.id);
});

test('defaultDeck：默认牌组被删时兜底第一套', () => {
  const s = mockStorage();
  const p = createSave('A', 'avatar_1', s);
  const second = { id: 'd2', name: '第二套', cards: [...p.decks[0].cards] };
  p.decks.push(second);
  p.defaultDeckId = 'd2';
  updateSave(p, s);
  assert.equal(defaultDeck(loadSaves(s)[0]).id, 'd2');
  p.defaultDeckId = '不存在的id';
  assert.equal(defaultDeck(p).id, p.decks[0].id);
});

test('对战记录：最新在前，超出 50 条截断', () => {
  const s = mockStorage();
  const p = createSave('A', 'avatar_1', s);
  for (let i = 0; i < 55; i++) {
    pushHistory(p, { at: i, mode: 'single', opp: 'bot', win: i % 2 === 0, turns: 20, deckName: '默认牌组' }, s);
  }
  const loaded = loadSaves(s)[0];
  assert.equal(loaded.history.length, 50);
  assert.equal(loaded.history[0].at, 54, '最新一条在最前');
});

test('损坏的存储数据兜底为空列表', () => {
  const s = mockStorage();
  s.setItem('cardetect_saves', '{不是JSON');
  assert.deepEqual(loadSaves(s), []);
});

console.log(`\n全部 ${passed} 个测试通过 ✅`);
