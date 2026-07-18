import { useMemo, useState } from 'react';
import {
  CARDS,
  DECK_SIZE,
  FACTION_DEFS,
  KEYWORD_DEFS,
  SAME_CARD_LIMIT,
  buildDefaultDeck,
  deckFaction,
  validateDeck,
  type CardDef,
  type Deck,
  type Faction,
  type Keyword,
} from '@cardetect/shared';
import { updateSave, type SaveProfile } from '../saves';

/** 关键词标签：与 Battle 同款悬停说明（文案统一来自 KEYWORD_DEFS） */
function KwTag({ kw }: { kw: Keyword }): JSX.Element {
  const def = KEYWORD_DEFS[kw];
  return (
    <span className="kw" data-tip={def?.desc ?? ''}>
      {def?.name ?? kw}
    </span>
  );
}

const KIND_NAMES: Record<CardDef['kind'], string> = { unit: '单位', spell: '法术', buff: '强化', trap: '埋伏' };
/** 卡池分组顺序：中立在前，随后各门派 */
const FACTION_ORDER: (Faction | undefined)[] = [undefined, 'wuying', 'tieji', 'wudu', 'tianji'];

let uidCounter = 0;
function uid(): string {
  return `${Date.now().toString(36)}${(uidCounter++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** 组牌器：牌组列表 + 牌表/卡池两栏编辑，所有修改即时写回存档 */
export default function DeckBuilder({
  save,
  onChange,
  onBack,
  toast,
}: {
  save: SaveProfile;
  onChange: (save: SaveProfile) => void;
  onBack: () => void;
  toast: (msg: string) => void;
}): JSX.Element {
  const [selectedId, setSelectedId] = useState(save.defaultDeckId);
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState('');

  const deck = save.decks.find((d) => d.id === selectedId) ?? save.decks[0];

  /** 所有修改统一入口：持久化 + 通知 App 刷新 currentSave */
  const commit = (next: SaveProfile): void => {
    updateSave(next);
    onChange(next);
  };
  const mutateDeck = (fn: (d: Deck) => Deck): void => {
    commit({ ...save, decks: save.decks.map((d) => (d.id === deck.id ? fn(d) : d)) });
  };

  // ---------- 牌组操作 ----------
  const addDeck = (): void => {
    const d: Deck = { id: uid(), name: `牌组 ${save.decks.length + 1}`, cards: buildDefaultDeck() };
    commit({ ...save, decks: [...save.decks, d] });
    setSelectedId(d.id);
    setRenaming(false);
    toast(`已新建「${d.name}」（内容为默认牌组，可自行调整）`);
  };

  const removeDeck = (): void => {
    if (save.decks.length <= 1) {
      toast('至少保留一套牌组，最后一套不可删除');
      return;
    }
    const rest = save.decks.filter((d) => d.id !== deck.id);
    commit({ ...save, decks: rest, defaultDeckId: save.defaultDeckId === deck.id ? rest[0].id : save.defaultDeckId });
    setSelectedId(rest[0].id);
    setRenaming(false);
    toast(`已删除「${deck.name}」`);
  };

  const setDefault = (): void => {
    commit({ ...save, defaultDeckId: deck.id });
    toast(`「${deck.name}」已设为默认牌组`);
  };

  const confirmRename = (): void => {
    const name = renameText.trim();
    if (!name) return;
    mutateDeck((d) => ({ ...d, name }));
    setRenaming(false);
  };

  // ---------- 牌表/卡池 ----------
  /** 牌表行：按费用排序聚合数量 */
  const deckRows = useMemo(() => {
    const counts = new Map<string, number>();
    for (const id of deck.cards) counts.set(id, (counts.get(id) ?? 0) + 1);
    return [...counts.entries()]
      .map(([id, count]) => ({ def: CARDS[id], count }))
      .filter((r): r is { def: CardDef; count: number } => !!r.def)
      .sort((a, b) => a.def.cost - b.def.cost || a.def.name.localeCompare(b.def.name, 'zh'));
  }, [deck.cards]);

  /** 卡池：全部非 token 卡，按 中立/各门派 分组，组内按费用排序 */
  const poolGroups = useMemo(() => {
    const all = Object.values(CARDS).filter((c) => !c.token);
    return FACTION_ORDER.map((f) => ({
      faction: f,
      cards: all
        .filter((c) => c.faction === f)
        .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name, 'zh')),
    })).filter((g) => g.cards.length > 0);
  }, []);

  /** 加入限制：返回禁点原因，可加则返回 null */
  const addBlockReason = (def: CardDef): string | null => {
    const count = deck.cards.filter((c) => c === def.id).length;
    if (count >= SAME_CARD_LIMIT) return `「${def.name}」最多带 ${SAME_CARD_LIMIT} 张`;
    if (deck.cards.length >= DECK_SIZE) return `牌组已满 ${DECK_SIZE} 张`;
    if (def.faction) {
      const f = deckFaction(deck.cards);
      if (f && f !== def.faction) return `已选定「${FACTION_DEFS[f].name}」，不能再加入其他门派`;
    }
    return null;
  };

  const addCard = (def: CardDef): void => {
    const reason = addBlockReason(def);
    if (reason) {
      toast(reason);
      return;
    }
    mutateDeck((d) => ({ ...d, cards: [...d.cards, def.id] }));
  };

  const removeCard = (cardId: string): void => {
    mutateDeck((d) => {
      const i = d.cards.indexOf(cardId);
      if (i < 0) return d;
      const cards = [...d.cards];
      cards.splice(i, 1);
      return { ...d, cards };
    });
  };

  const deckError = validateDeck(deck.cards);
  const isDefault = deck.id === save.defaultDeckId;

  return (
    <div className="deckbuilder">
      <div className="deckbuilder-top">
        <h2 className="page-title">牌组管理 · {save.name}</h2>
        <button className="btn btn-ghost btn-small" onClick={onBack}>返回存档</button>
      </div>

      {/* 牌组列表 */}
      <div className="deck-tabs">
        {save.decks.map((d) => (
          <button
            key={d.id}
            className={d.id === deck.id ? 'deck-tab active' : 'deck-tab'}
            onClick={() => { setSelectedId(d.id); setRenaming(false); }}
          >
            {d.id === save.defaultDeckId && <span className="default-star">★ </span>}
            {d.name}
          </button>
        ))}
        <button className="deck-tab" onClick={addDeck}>＋ 新建牌组</button>
      </div>

      {/* 当前牌组操作 */}
      <div className="deck-actions">
        {renaming ? (
          <>
            <input
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              maxLength={16}
              placeholder="输入牌组名称"
              onKeyDown={(e) => e.key === 'Enter' && confirmRename()}
            />
            <button className="btn btn-small" onClick={confirmRename} disabled={!renameText.trim()}>确定</button>
            <button className="btn btn-ghost btn-small" onClick={() => setRenaming(false)}>取消</button>
          </>
        ) : (
          <>
            <button className="btn btn-ghost btn-small" onClick={() => { setRenameText(deck.name); setRenaming(true); }}>重命名</button>
            {!isDefault && <button className="btn btn-ghost btn-small" onClick={setDefault}>设为默认</button>}
            {isDefault && <span className="tag waiting">默认牌组</span>}
            <button className="btn btn-danger btn-small" onClick={removeDeck} disabled={save.decks.length <= 1}>删除牌组</button>
          </>
        )}
      </div>

      <div className="deck-columns">
        {/* 牌表 */}
        <div className="deck-panel">
          <h3>牌表（点击移除一张）</h3>
          <div className="deck-rows">
            {deckRows.length === 0 && <div className="empty-hint">空牌组，从右侧卡池加入卡牌</div>}
            {deckRows.map(({ def, count }) => (
              <button key={def.id} className="deck-row" onClick={() => removeCard(def.id)} title="点击移除一张">
                <span className="pool-cost">{def.cost}</span>
                <span className="deck-row-name">{def.name}</span>
                <span className="deck-row-count">×{count}</span>
              </button>
            ))}
          </div>
          <div className="deck-status">
            <span className={deckError ? 'deck-count bad' : 'deck-count ok'}>{deck.cards.length}/{DECK_SIZE}</span>
            {deckError
              ? <span className="deck-err">{deckError}</span>
              : <span className="deck-ok">✓ 牌组合法，可用于开局</span>}
          </div>
        </div>

        {/* 卡池 */}
        <div className="pool-panel">
          <h3>卡池（点击加入一张）</h3>
          <div className="pool-groups">
            {poolGroups.map((g) => (
              <div key={g.faction ?? 'neutral'}>
                <div
                  className="pool-group-title"
                  data-tip={g.faction ? FACTION_DEFS[g.faction].desc : '不属于任何门派的通用卡牌'}
                >
                  {g.faction ? FACTION_DEFS[g.faction].name : '中立'}
                </div>
                {g.cards.map((def) => {
                  const reason = addBlockReason(def);
                  return (
                    <button
                      key={def.id}
                      className={reason ? 'pool-card disabled' : 'pool-card'}
                      title={reason ?? '点击加入一张'}
                      onClick={() => addCard(def)}
                    >
                      <span className="pool-cost">{def.cost}</span>
                      <span className="pool-main">
                        <span className="pool-name">
                          {def.name}
                          <span className="pool-kind">{KIND_NAMES[def.kind]}</span>
                        </span>
                        <span className="pool-desc">{def.desc}</span>
                        {def.keywords && def.keywords.length > 0 && (
                          <span className="unit-kws pool-kws">{def.keywords.map((k) => <KwTag key={k} kw={k} />)}</span>
                        )}
                      </span>
                      {def.kind === 'unit' && (
                        <span className="pool-stats">
                          <span className="stat-atk">{def.atk}</span>
                          /
                          <span className="stat-hp">{def.hp}</span>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
