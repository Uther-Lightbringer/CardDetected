import { buildDefaultDeck, type Deck, type GameState } from '@cardetect/shared';

/**
 * 单人本地存档（仅单人游戏使用，与服务器账号无关）。
 * 存 localStorage `cardetect_saves`，仿 settings.ts 的加载/兜底模式。
 * 牌组存在存档里；多人对战开局时把所选牌组发给服务器校验后使用。
 */

export interface SavedGame {
  state: GameState;
  seed: number;
  savedAt: number;
}

export interface MatchRecord {
  at: number;
  mode: 'single' | 'multi';
  opp: string;
  win: boolean;
  turns: number;
  deckName: string;
}

export interface SaveProfile {
  id: string;
  name: string;
  avatar: string;
  createdAt: number;
  decks: Deck[];
  defaultDeckId: string;
  /** 进行中的单人局快照（继续对局用），无则 null */
  activeGame: SavedGame | null;
  history: MatchRecord[]; // 最多保留 50 条
}

const KEY = 'cardetect_saves';
const LAST_KEY = 'cardetect_last_save';
export const HISTORY_LIMIT = 50;

/** 可注入的存储（测试用内存 mock，浏览器用 localStorage） */
export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const memory = new Map<string, string>();
const fallback: StorageLike = {
  getItem: (k) => memory.get(k) ?? null,
  setItem: (k, v) => void memory.set(k, v),
};

function store(s?: StorageLike): StorageLike {
  return s ?? (globalThis as { localStorage?: StorageLike }).localStorage ?? fallback;
}

export function loadSaves(s?: StorageLike): SaveProfile[] {
  try {
    const raw = store(s).getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as SaveProfile[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function persist(saves: SaveProfile[], s?: StorageLike): void {
  store(s).setItem(KEY, JSON.stringify(saves));
}

let uidCounter = 0;
function uid(): string {
  return `${Date.now().toString(36)}${(uidCounter++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** 新建存档：自带一套合法默认牌组 */
export function createSave(name: string, avatar: string, s?: StorageLike): SaveProfile {
  const deck: Deck = { id: uid(), name: '默认牌组', cards: buildDefaultDeck() };
  const profile: SaveProfile = {
    id: uid(),
    name,
    avatar,
    createdAt: Date.now(),
    decks: [deck],
    defaultDeckId: deck.id,
    activeGame: null,
    history: [],
  };
  const saves = loadSaves(s);
  saves.push(profile);
  persist(saves, s);
  return profile;
}

export function updateSave(profile: SaveProfile, s?: StorageLike): void {
  const saves = loadSaves(s);
  const i = saves.findIndex((x) => x.id === profile.id);
  if (i >= 0) saves[i] = profile;
  else saves.push(profile);
  persist(saves, s);
}

export function deleteSave(id: string, s?: StorageLike): void {
  persist(loadSaves(s).filter((x) => x.id !== id), s);
}

/** 存档的默认牌组（兜底第一套） */
export function defaultDeck(save: SaveProfile): Deck {
  return save.decks.find((d) => d.id === save.defaultDeckId) ?? save.decks[0];
}

/** 追加一条对战记录（最新在前，超量截断） */
export function pushHistory(save: SaveProfile, rec: MatchRecord, s?: StorageLike): void {
  save.history = [rec, ...save.history].slice(0, HISTORY_LIMIT);
  updateSave(save, s);
}

/** 记录最近使用的存档 id（多人开局时取它的默认牌组） */
export function setLastSaveId(id: string, s?: StorageLike): void {
  store(s).setItem(LAST_KEY, id);
}

/** 最近使用的存档（无存档或记录已失效时返回 null） */
export function lastSave(s?: StorageLike): SaveProfile | null {
  const id = store(s).getItem(LAST_KEY);
  if (!id) return null;
  return loadSaves(s).find((x) => x.id === id) ?? null;
}
