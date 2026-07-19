import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CARDS,
  FACTION_DEFS,
  KEYWORD_DEFS,
  legalTargets,
  type GameEvent,
  type GameState,
  type GameView,
  type Keyword,
  type PlayerIndex,
  type PlayerState,
  type Row,
  type TargetRef,
  type UnitRef,
  type UnitState,
} from '@cardetect/shared';
import type { BattleSession } from '../App';
import { SYSTEM_PROMPT, type LlmDebugRecord } from '../ai/deepseek';
import { AvatarImage } from '../avatar';
import { SkinImage } from '../skin';

type ExitDest = 'menu' | 'rematch' | 'room' | 'lobby';

/** 用视角数据拼一个引擎可读的伪状态（仅棋盘与胜负字段是真实的） */
function pseudoState(v: GameView): GameState {
  const mk = (hp: number, maxHp: number, board: PlayerState['board']): PlayerState => ({
    hp, maxHp, mana: 0, maxMana: 0, deck: [], hand: [], fatigue: 0, board, traps: [null, null, null],
  });
  const meP = mk(v.me.hp, v.me.maxHp, v.me.board);
  const oppP = mk(v.opp.hp, v.opp.maxHp, v.opp.board);
  const players: [PlayerState, PlayerState] = v.mySide === 0 ? [meP, oppP] : [oppP, meP];
  return { players, turn: v.turn, current: v.current, uidCounter: 0, winner: v.winner };
}

/** 关键词标签：悬停显示规则说明（文案统一来自 shared 的 KEYWORD_DEFS） */
function KwTag({ kw }: { kw: Keyword }): JSX.Element {
  const def = KEYWORD_DEFS[kw];
  return (
    <span className="kw" data-tip={def?.desc ?? ''}>
      {def?.name ?? kw}
    </span>
  );
}

export default function Battle({
  session,
  onExit,
  toast,
}: {
  session: BattleSession;
  onExit: (d: ExitDest) => void;
  toast: (msg: string) => void;
}): JSX.Element {
  const { adapter } = session;
  const [view, setView] = useState<GameView | null>(null);
  /** 日志条目：side 决定颜色（me=我方绿 / opp=敌方红 / sys=系统灰） */
  interface LogLine { text: string; side: 'me' | 'opp' | 'sys' }
  const [log, setLog] = useState<LogLine[]>([]);
  const [result, setResult] = useState<{ winner: PlayerIndex; reason: string } | null>(null);
  const [revealHand, setRevealHand] = useState<string[] | null>(null);
  const [selectedHand, setSelectedHand] = useState<number | null>(null); // 单位牌选位
  const [spellSource, setSpellSource] = useState<number | null>(null); // 伤害法术选目标
  const [buffSource, setBuffSource] = useState<number | null>(null); // 传功/淬毒选友方单位
  const [attacker, setAttacker] = useState<UnitRef | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [debugRecords, setDebugRecords] = useState<LlmDebugRecord[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  // ---------- 动效状态 ----------
  interface Floater { id: number; side: 'me' | 'opp'; slot: string; text: string }
  interface DyingUnit { id: number; side: 'me' | 'opp'; row: Row; slot: number; unit: UnitState }
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [dying, setDying] = useState<DyingUnit[]>([]);
  const [combatFx, setCombatFx] = useState<{ key: number; attacker: UnitRef; attackerEnemy: boolean; target: TargetRef } | null>(null);
  const [turnBanner, setTurnBanner] = useState(0);
  const [hpPulse, setHpPulse] = useState({ me: 0, opp: 0 });
  /** AI 台词气泡（显示在对手头像旁，几秒后自动消失） */
  const [aiBubble, setAiBubble] = useState<{ id: number; text: string } | null>(null);
  const viewRef = useRef<GameView | null>(null);
  /** hover 大卡：鼠标悬停单位卡 0.5s 后弹出，锚定在进入点，移出即消 */
  interface UnitTooltipInfo { unit: UnitState; x: number; y: number }
  const [unitTooltip, setUnitTooltip] = useState<UnitTooltipInfo | null>(null);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showUnitTooltip = (e: React.MouseEvent, unit: UnitState): void => {
    tooltipTimerRef.current && clearTimeout(tooltipTimerRef.current);
    tooltipTimerRef.current = setTimeout(() => {
      setUnitTooltip({ unit, x: e.clientX, y: e.clientY });
    }, 500);
  };
  const hideUnitTooltip = (): void => {
    tooltipTimerRef.current && clearTimeout(tooltipTimerRef.current);
    setUnitTooltip(null);
  };
  const fxIdRef = useRef(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const later = (ms: number, fn: () => void): void => {
    timersRef.current.push(setTimeout(fn, ms));
  };
  useEffect(() => () => timersRef.current.forEach(clearTimeout), []);

  const addFloater = (side: 'me' | 'opp', slot: string, text: string): void => {
    const id = ++fxIdRef.current;
    setFloaters((old) => [...old, { id, side, slot, text }]);
    later(950, () => setFloaters((old) => old.filter((f) => f.id !== id)));
  };
  const addDying = (side: 'me' | 'opp', row: Row, slot: number, unit: UnitState): void => {
    const id = ++fxIdRef.current;
    setDying((old) => [...old, { id, side, row, slot, unit }]);
    later(680, () => setDying((old) => old.filter((d) => d.id !== id)));
  };

  // 调试面板打开时每秒刷新一次记录（AI 可能正在思考）
  useEffect(() => {
    if (!showDebug || !adapter.getLlmDebugLog) return;
    const refresh = (): void => setDebugRecords([...(adapter.getLlmDebugLog?.() ?? [])]);
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [showDebug, adapter]);

  const mySide = adapter.mySide;
  const myTurn = !!view && view.current === mySide && !result && view.winner === null;

  // ---------- 适配器接入 ----------
  useEffect(() => {
    adapter.hooks = {
      onUpdate: (v, events) => {
        const prev = viewRef.current;
        viewRef.current = v;
        setView(v);
        if (!prev && v.winner === null) {
          // 首回合没有 turn_start 事件，日志手动补上起始行
          setLog([{ text: `—— 第 ${v.turn} 回合 · ${v.current === v.mySide ? '你' : '对手'}行动 ——`, side: 'sys' }]);
        }
        if (prev) {
          if (v.me.hp !== prev.me.hp) setHpPulse((p) => ({ ...p, me: p.me + 1 }));
          if (v.opp.hp !== prev.opp.hp) setHpPulse((p) => ({ ...p, opp: p.opp + 1 }));
        }
        handleEvents(events, v, prev);
      },
      onGameOver: (winner, reason) => setResult({ winner, reason }),
      onError: (msg) => toast(msg),
    };
    adapter.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter]);

  const handleEvents = (events: GameEvent[], v: GameView, prev: GameView | null): void => {
    const lines: LogLine[] = [];
    for (const e of events) {
      const who = e.player === v.mySide ? '你' : '对手';
      const side: LogLine['side'] = e.player === v.mySide ? 'me' : 'opp';
      switch (e.type) {
        case 'turn_start':
          lines.push({ text: `—— 第 ${e.turn} 回合 · ${who}行动 ——`, side: 'sys' });
          setTurnBanner(++fxIdRef.current);
          later(1300, () => setTurnBanner(0));
          break;
        case 'play_card':
          // 对手盖放易容单位 / 布下埋伏时，引擎已抹掉 card 字段
          if (e.card === undefined) {
            lines.push({ text: e.trap ? `${who}布下一张埋伏` : `${who}盖放了一个单位`, side });
          } else {
            lines.push({ text: `${who}打出「${CARDS[e.card as string]?.name ?? e.card}」`, side });
          }
          break;
        case 'trap_trigger':
          lines.push({ text: `⚔️ 「${CARDS[e.card as string]?.name ?? e.card}」被触发！`, side });
          break;
        case 'unit_reveal':
          lines.push({
            text: `🎭 路人翻开真身：「${CARDS[e.card as string]?.name ?? e.card}」${e.forced ? '（被识破，当回合休整）' : ''}`,
            side,
          });
          break;
        case 'attack': {
          lines.push({
            text:
              e.target === 'player'
                ? `${who}的单位直击对方棋手，造成 ${e.damage} 点伤害！`
                : `${who}的单位发起攻击（${e.damage} 伤害${e.counter ? `，被反击 ${e.counter}` : ''}）`,
            side,
          });
          // 动效：攻击者冲刺 + 目标抖动 + 伤害飘字
          const enemy = e.player !== v.mySide;
          const atkRef = e.attacker as UnitRef;
          setCombatFx({ key: ++fxIdRef.current, attacker: atkRef, attackerEnemy: enemy, target: e.target as TargetRef });
          later(470, () => setCombatFx(null));
          if (e.target === 'player') addFloater(enemy ? 'me' : 'opp', 'hero', `-${e.damage}`);
          else {
            const t = e.target as UnitRef;
            addFloater(enemy ? 'me' : 'opp', `${t.row}${t.slot}`, `-${e.damage}`);
          }
          if (e.counter) addFloater(enemy ? 'opp' : 'me', `${atkRef.row}${atkRef.slot}`, `-${e.counter}`);
          break;
        }
        case 'damage': {
          lines.push({ text: `「${CARDS[e.source as string]?.name ?? '法术'}」造成 ${e.amount} 点伤害`, side });
          const t = e.target as UnitRef;
          addFloater(e.player === v.mySide ? 'opp' : 'me', `${t.row}${t.slot}`, `-${e.amount}`);
          break;
        }
        case 'death': {
          lines.push({ text: `${who}的「${CARDS[e.card as string]?.name ?? e.card}」被消灭`, side });
          // 动效：从上一帧取出单位做消散动画
          const row = e.row as Row;
          const slot = e.slot as number;
          const board = e.player === v.mySide ? prev?.me.board : prev?.opp.board;
          const unit = board?.[row][slot];
          if (unit) addDying(e.player === v.mySide ? 'me' : 'opp', row, slot, unit);
          break;
        }
        case 'draw':
          lines.push({ text: e.player === v.mySide ? `你抽了 ${(e.cards as string[]).length} 张牌` : '对手抽了 1 张牌', side });
          break;
        case 'fatigue':
          lines.push({ text: `${who}牌库已空，疲劳受到 ${e.damage} 点伤害`, side });
          addFloater(e.player === v.mySide ? 'me' : 'opp', 'hero', `-${e.damage}`);
          break;
        case 'burn':
          if (e.player === v.mySide) lines.push({ text: `手牌已满，「${CARDS[e.card as string]?.name ?? e.card}」被烧毁`, side: 'me' });
          break;
        case 'reveal':
          setRevealHand(e.hand as string[]);
          lines.push({ text: '🔍 你识破了对手的手牌！', side: 'me' });
          break;
        case 'pollute':
          lines.push({ text: `☠️ ${who}下毒：${e.amount} 张「蛊奴」被洗入${e.player === v.mySide ? '对手' : '你'}的牌库`, side });
          break;
        case 'purify':
          lines.push({ text: `🍵 ${who}驱毒，移除了牌库中 ${e.removed} 张「蛊奴」`, side });
          break;
        case 'shuffle_deck':
          lines.push({ text: `🌀 ${who}打乱了对手的牌库顺序`, side });
          break;
        case 'buff': {
          lines.push({ text: `✨ ${who}施加了「${e.name}」`, side });
          break;
        }
        case 'buff_expire':
          lines.push({ text: `💨 「${e.name}」的效果消散了`, side: 'sys' });
          break;
        case 'ai_comment': {
          lines.push({ text: `🗨 对手：「${e.text}」`, side: 'opp' });
          const id = ++fxIdRef.current;
          setAiBubble({ id, text: String(e.text) });
          later(4100, () => setAiBubble((b) => (b?.id === id ? null : b)));
          break;
        }
      }
    }
    if (lines.length > 0) setLog((old) => [...old, ...lines].slice(-200));
  };

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  // ---------- 交互 ----------
  const clearSelection = (): void => {
    setSelectedHand(null);
    setSpellSource(null);
    setBuffSource(null);
    setAttacker(null);
  };

  const state = view ? pseudoState(view) : null;
  const legal = useMemo(
    () => (attacker && state ? legalTargets(state, mySide, attacker) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attacker, view],
  );

  const clickHandCard = (i: number): void => {
    if (!myTurn || !view) return;
    const def = CARDS[view.me.hand[i]];
    if (!def) return;
    if (def.cost > view.me.mana) {
      toast('内力不足');
      return;
    }
    if (def.kind === 'unit') {
      setSelectedHand(selectedHand === i ? null : i);
      setSpellSource(null);
      setBuffSource(null);
      setAttacker(null);
    } else if (def.kind === 'buff') {
      setBuffSource(buffSource === i ? null : i);
      setSelectedHand(null);
      setSpellSource(null);
      setAttacker(null);
    } else if ((def.effects ?? []).some((e) => e.actions.some((a) => a.kind === 'damage' || a.kind === 'reveal_unit'))) {
      // 需要敌方单位目标的法术（袖里剑 / 照妖镜）：进入选目标流程
      setSpellSource(spellSource === i ? null : i);
      setSelectedHand(null);
      setBuffSource(null);
      setAttacker(null);
    } else {
      adapter.act({ type: 'play_card', handIndex: i, row: 'front', slot: 0 });
      clearSelection();
    }
  };

  const clickMySlot = (row: Row, slot: number): void => {
    if (!myTurn || !view) return;
    if (buffSource !== null) {
      if (!view.me.board[row][slot]) return;
      adapter.act({ type: 'play_card', handIndex: buffSource, row: 'front', slot: 0, target: { row, slot } });
      clearSelection();
      return;
    }
    if (selectedHand !== null) {
      if (view.me.board[row][slot]) return;
      adapter.act({ type: 'play_card', handIndex: selectedHand, row, slot });
      clearSelection();
      return;
    }
    const unit = view.me.board[row][slot];
    if (unit && canAttackUnit(unit)) {
      setAttacker(attacker && attacker.row === row && attacker.slot === slot ? null : { row, slot });
      setSelectedHand(null);
      setSpellSource(null);
    }
  };

  const clickEnemyUnit = (row: Row, slot: number): void => {
    if (!myTurn || !view) return;
    const ref: UnitRef = { row, slot };
    if (spellSource !== null) {
      adapter.act({ type: 'play_card', handIndex: spellSource, row: 'front', slot: 0, target: ref });
      clearSelection();
      return;
    }
    if (attacker) {
      const ok = legal.some((t) => t !== 'player' && t.row === row && t.slot === slot);
      if (ok) {
        adapter.act({ type: 'attack', attacker, target: ref });
        clearSelection();
      }
    }
  };

  const clickOppHero = (): void => {
    if (!myTurn || !attacker) return;
    if (legal.includes('player')) {
      adapter.act({ type: 'attack', attacker, target: 'player' as TargetRef });
      clearSelection();
    }
  };

  const endTurn = (): void => {
    if (!myTurn) return;
    clearSelection();
    adapter.act({ type: 'end_turn' });
  };

  /** 与引擎 legalTargets 一致的可攻击判定（带 self_ready 的易容单位休整中也可宣告攻击） */
  const canAttackUnit = (unit: UnitState): boolean => {
    if (unit.attacked) return false;
    if (!unit.sick) return true;
    if (!unit.faceDown) return false;
    const def = CARDS[unit.cardId];
    return !!(def?.effects ?? []).some(
      (e) => e.trigger === 'on_reveal' && e.actions.some((a) => a.kind === 'self_ready'),
    );
  };

  if (!view) return <div className="page"><div className="empty-hint">对局加载中…</div></div>;

  const winnerIsMe = result && result.winner === mySide;
  const targetEnemy = (t: TargetRef): t is UnitRef => t !== 'player';
  const isLegalTarget = (row: Row, slot: number): boolean =>
    legal.filter(targetEnemy).some((t) => t.row === row && t.slot === slot);

  // ---------- 渲染 ----------
  const renderUnit = (unit: UnitState | null, opts: {
    onClick?: () => void;
    highlight?: boolean;
    selected?: boolean;
    mine?: boolean;
    extraClass?: string;
    floaters?: Floater[];
  }) => {
    if (!unit) {
      return (
        <div className={`slot empty ${opts.highlight ? 'droppable' : ''}`} onClick={opts.onClick}>
          {opts.highlight && <span className="slot-hint">部署</span>}
          {opts.floaters?.map((f) => <span key={f.id} className="floater">{f.text}</span>)}
        </div>
      );
    }
    const def = CARDS[unit.cardId];
    const idle = opts.mine && !canAttackUnit(unit);
    // 对手盖放的易容单位：渲染为 1/1 路人，不显示关键词与 buff
    if (unit.faceDown && !opts.mine) {
      return (
        <div
          className={`slot unit facedown ${opts.highlight ? 'targetable' : ''} ${opts.extraClass ?? ''}`}
          onClick={opts.onClick}
          title="易容：盖放的路人，真身未知"
        >
          <span className="unit-art-fallback">🎭</span>
          <div className="unit-name">路人</div>
          <div className="unit-stats">
            <span className="stat-atk">{unit.atk}</span>
            <span className="stat-hp">{unit.hp}</span>
          </div>
          {opts.floaters?.map((f) => <span key={f.id} className="floater">{f.text}</span>)}
        </div>
      );
    }
    return (
      <div
        className={`slot unit ${opts.highlight ? 'targetable' : ''} ${opts.selected ? 'selected' : ''} ${idle ? 'idle' : ''} ${opts.mine && myTurn && !idle ? 'ready' : ''} ${opts.extraClass ?? ''}`}
        onClick={opts.onClick}
        onMouseEnter={def ? (e) => showUnitTooltip(e, unit) : undefined}
        onMouseLeave={hideUnitTooltip}
      >
        {def?.cost != null && <div className="unit-cost">{def.cost}</div>}
        <div className="unit-art-wrap">
          <SkinImage skinKey={def?.art ?? ''} alt={unit.name} className="unit-art" fallback={<span className="unit-art-fallback">🂠</span>} />
        </div>
        <div className="unit-stats-bar">
          <span className="stat-atk">{unit.atk}</span>
          <span className={unit.hp < unit.maxHp ? 'stat-hp hurt' : 'stat-hp'}>{unit.hp}</span>
        </div>
        {unit.sick && opts.mine && !canAttackUnit(unit) && <div className="unit-sick">休整中</div>}
        {opts.floaters?.map((f) => <span key={f.id} className="floater">{f.text}</span>)}
      </div>
    );
  };

  /** 渲染一个棋盘格：活单位 / 死亡幽灵 / 空位，并叠加战斗特效与飘字 */
  const renderBoardSlot = (
    u: UnitState | null,
    side: 'me' | 'opp',
    row: Row,
    slot: number,
    opts: { onClick?: () => void; highlight?: boolean; selected?: boolean },
  ): JSX.Element => {
    const sk = `${row}${slot}`;
    const slotFloaters = floaters.filter((f) => f.side === side && f.slot === sk);
    const isAttackerFx =
      !!combatFx && combatFx.attacker.row === row && combatFx.attacker.slot === slot &&
      (combatFx.attackerEnemy ? side === 'opp' : side === 'me');
    const isTargetFx =
      !!combatFx && combatFx.target !== 'player' && combatFx.target.row === row && combatFx.target.slot === slot &&
      (combatFx.attackerEnemy ? side === 'me' : side === 'opp');
    const fxClass = `${isAttackerFx ? (side === 'me' ? 'fx-lunge-up' : 'fx-lunge-down') : ''} ${isTargetFx ? 'fx-shake' : ''}`;

    if (!u) {
      const ghost = dying.find((d) => d.side === side && d.row === row && d.slot === slot);
      if (ghost) {
        return <div key={`ghost-${ghost.id}`}>{renderUnit(ghost.unit, { extraClass: 'fx-dying', floaters: slotFloaters })}</div>;
      }
      return (
        <div key={`e-${side}-${row}-${slot}`}>
          {renderUnit(null, { onClick: opts.onClick, highlight: opts.highlight, floaters: slotFloaters })}
        </div>
      );
    }
    // key 绑定 uid：新单位重新挂载 → 自动播放入场动画
    return (
      <div key={`u${u.uid}`}>
        {renderUnit(u, { mine: side === 'me', onClick: opts.onClick, highlight: opts.highlight, selected: opts.selected, extraClass: fxClass, floaters: slotFloaters })}
      </div>
    );
  };

  const renderHandCard = (cardId: string, i: number): JSX.Element => {
    const def = CARDS[cardId];
    if (!def) return <div key={i} />;
    const affordable = myTurn && def.cost <= view.me.mana;
    const selected = selectedHand === i || spellSource === i || buffSource === i;
    return (
      <div
        key={`${cardId}-${i}`}
        className={`hand-card ${def.faction ? `faction-${def.faction}` : 'faction-neutral'} kind-${def.kind} ${affordable ? '' : 'disabled'} ${selected ? 'selected' : ''}`}
        onClick={() => clickHandCard(i)}
        title={def.desc}
      >
        <div className="card-cost">{def.cost}</div>
        <SkinImage skinKey={def.art ?? ''} alt={def.name} className="card-art" fallback={<span className="card-art-fallback">{def.kind === 'unit' ? '🗡️' : '📜'}</span>} />
        <div className="card-name">{def.name}</div>
        {def.faction && (
          <div className="card-faction" data-tip={FACTION_DEFS[def.faction].desc}>{FACTION_DEFS[def.faction].name}</div>
        )}
        <div className="card-desc">{def.desc}</div>
        {def.kind === 'unit' && (
          <div className="card-stats"><span className="stat-atk">{def.atk}</span><span className="stat-hp">{def.hp}</span></div>
        )}
        {def.kind === 'unit' && def.keywords && def.keywords.length > 0 && (
          <div className="unit-kws">{def.keywords.map((k) => <KwTag key={k} kw={k} />)}</div>
        )}
      </div>
    );
  };

  return (
    <div className="battle">
      <SkinImage skinKey="battle_bg" alt="" className="battle-bg" fallback={<div className="battle-bg menu-bg-fallback" />} />
      <div className="battle-main">
        {/* 对手：头像(左) | 手牌背(中) | 气血/内力/埋伏(右) */}
        <div
          className={`hand-zone opp-zone ${attacker && legal.includes('player') ? 'targetable' : ''}`}
          onClick={clickOppHero}
        >
          <div className="hero-side">
            <AvatarImage avatar={session.oppAvatar} className="avatar-img" />
            <div className="hero-info">
              <div className="hero-name">{session.oppName}</div>
              <div className="hero-sub">🃏 {view.opp.handCount} 手牌 · 📚 {view.opp.deckCount} 牌库</div>
            </div>
            {aiBubble && <div key={aiBubble.id} className="speech-bubble">{aiBubble.text}</div>}
          </div>
          <div className="hand opp-hand">
            {Array.from({ length: view.opp.handCount }, (_, i) => (
              // 平铺叠放：不旋转，上缘对齐，均匀压缩占位
              <span key={i} className="card-back-tile">
                <SkinImage skinKey="card_back" alt="牌背" className="card-back" fallback={<span className="card-back-fallback" />} />
              </span>
            ))}
          </div>
          <div className={`hero-side right ${combatFx && combatFx.target === 'player' && !combatFx.attackerEnemy ? 'fx-shake' : ''}`}>
            <div className="hero-numbers">
              <span key={hpPulse.opp} className={hpPulse.opp > 0 ? 'hp fx-pulse' : 'hp'}>❤ {view.opp.hp}</span>
              <span className="mana">◆ {view.opp.mana}/{view.opp.maxMana}</span>
            </div>
            <span className="trap-count">埋伏 {view.opp.trapCount}/3</span>
            {attacker && legal.includes('player') && <span className="attack-hint">可攻击</span>}
            {floaters.filter((f) => f.side === 'opp' && f.slot === 'hero').map((f) => <span key={f.id} className="floater">{f.text}</span>)}
          </div>
        </div>

        {/* 对手棋盘：后排在上 */}
        <div className="board-row opp-row">
          {view.opp.board.back.map((u, i) =>
            renderBoardSlot(u, 'opp', 'back', i, {
              onClick: () => clickEnemyUnit('back', i),
              highlight: (spellSource !== null || attacker !== null) && (spellSource !== null || isLegalTarget('back', i)) && !!u,
            }),
          )}
        </div>
        <div className="board-row opp-row">
          {view.opp.board.front.map((u, i) =>
            renderBoardSlot(u, 'opp', 'front', i, {
              onClick: () => clickEnemyUnit('front', i),
              highlight: (spellSource !== null || attacker !== null) && (spellSource !== null || isLegalTarget('front', i)) && !!u,
            }),
          )}
        </div>

        <div key={`${view.turn}-${view.current}`} className="mid-banner mid-pulse">{myTurn ? '⚡ 你的回合' : '⏳ 对手行动中…'}</div>

        {/* 我的棋盘：前排在上 */}
        <div className="board-row my-row">
          {view.me.board.front.map((u, i) =>
            renderBoardSlot(u, 'me', 'front', i, {
              onClick: () => clickMySlot('front', i),
              highlight: (selectedHand !== null && !u) || (buffSource !== null && !!u),
              selected: !!attacker && attacker.row === 'front' && attacker.slot === i,
            }),
          )}
        </div>
        <div className="board-row my-row">
          {view.me.board.back.map((u, i) =>
            renderBoardSlot(u, 'me', 'back', i, {
              onClick: () => clickMySlot('back', i),
              highlight: (selectedHand !== null && !u) || (buffSource !== null && !!u),
              selected: !!attacker && attacker.row === 'back' && attacker.slot === i,
            }),
          )}
        </div>

        {/* 底部：头像(左) | 手牌(中) | 气血/内力/埋伏(右) */}
        <div className="hand-zone">
          <div className="hero-side">
            <AvatarImage avatar={session.myAvatar} className="avatar-img" />
            <div className="hero-info">
              <div className="hero-name">{session.myName}</div>
              <div className="hero-sub">📚 {view.me.deckCount} 牌库</div>
            </div>
          </div>
          <div className="hand">{view.me.hand.map(renderHandCard)}</div>
          <div className={`hero-side right ${combatFx && combatFx.target === 'player' && combatFx.attackerEnemy ? 'fx-shake' : ''}`}>
            <div className="hero-numbers">
              <span key={hpPulse.me} className={hpPulse.me > 0 ? 'hp fx-pulse' : 'hp'}>❤ {view.me.hp}</span>
              <span className="mana">◆ {view.me.mana}/{view.me.maxMana}</span>
            </div>
            {/* 我的埋伏区：可见卡名 */}
            <div className="trap-row">
              {view.me.traps.map((t, i) => (
                <span key={i} className={`trap-slot ${t ? 'filled' : ''}`} title={t ? CARDS[t]?.desc : '空埋伏位'}>
                  {t ? CARDS[t]?.name ?? '?' : '·'}
                </span>
              ))}
            </div>
            {floaters.filter((f) => f.side === 'me' && f.slot === 'hero').map((f) => <span key={f.id} className="floater">{f.text}</span>)}
          </div>
        </div>
      </div>

      {/* 侧边栏 */}
      <div className="battle-side">
        <button className="btn btn-endturn" onClick={endTurn} disabled={!myTurn}>结束回合</button>
        <button
          className="btn btn-ghost btn-small"
          onClick={() => (session.mode === 'single' ? onExit('menu') : onExit('lobby'))}
        >
          {session.mode === 'single' ? '放弃对局' : '认输离开'}
        </button>
        {adapter.getLlmDebugLog && (
          <button className="btn btn-ghost btn-small" onClick={() => setShowDebug(true)}>
            🔧 大模型调试
          </button>
        )}
        <div className="battle-log" ref={logRef}>
          {log.map((l, i) => <div key={i} className={`log-line log-${l.side}`}>{l.text}</div>)}
        </div>
      </div>

      {/* 回合横幅 */}
      {turnBanner > 0 && (
        <div key={turnBanner} className="turn-banner">
          {view.current === mySide ? '⚡ 你的回合' : '⏳ 对手回合'}
        </div>
      )}

      {/* 侦测结果 */}
      {revealHand && (
        <div className="modal-mask" onClick={() => setRevealHand(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>🔍 对手的手牌</h3>
            <div className="reveal-list">
              {revealHand.length === 0 && <div className="empty-hint">对手没有手牌</div>}
              {revealHand.map((id, i) => {
                const def = CARDS[id];
                return def ? (
                  <div key={i} className="reveal-card">
                    <span className="card-cost">{def.cost}</span> {def.name}
                    <span className="reveal-desc">{def.desc}</span>
                  </div>
                ) : null;
              })}
            </div>
            <button className="btn" onClick={() => setRevealHand(null)}>关闭</button>
          </div>
        </div>
      )}

      {/* 大模型调试面板 */}
      {showDebug && (
        <div className="modal-mask" onClick={() => setShowDebug(false)}>
          <div className="modal debug-modal" onClick={(e) => e.stopPropagation()}>
            <h3>🔧 大模型调试（输入/输出）</h3>
            <div className="debug-list">
              <details className="debug-record">
                <summary>📌 系统提示词（固定不变）</summary>
                <pre>{SYSTEM_PROMPT}</pre>
              </details>
              {debugRecords.length === 0 && <div className="empty-hint">还没有大模型调用记录（AI 回合后会出现）</div>}
              {[...debugRecords].reverse().map((r, i) => (
                <details key={i} className="debug-record" open={i === 0}>
                  <summary>
                    <span className={r.error ? 'debug-status fail' : 'debug-status ok'}>
                      {r.error ? '✗ 失败' : '✓ 成功'}
                    </span>
                    第 {r.turn} 回合 · {r.at} · {r.durationMs}ms
                  </summary>
                  <div className="debug-label">📤 发送给模型的输入（user prompt）：</div>
                  <pre>{r.prompt}</pre>
                  <div className="debug-label">📥 模型的原始输出：</div>
                  <pre>{r.error ? `⚠️ 错误：${r.error}` : r.response}</pre>
                </details>
              ))}
            </div>
            <button className="btn" onClick={() => setShowDebug(false)}>关闭</button>
          </div>
        </div>
      )}

      {/* 结算 */}
      {result && (
        <div className="modal-mask">
          <div className="modal result-modal">
            <div className="result-icon">{winnerIsMe ? '🏆' : '💀'}</div>
            <h2>{winnerIsMe ? '棋高一着！' : '满盘皆输…'}</h2>
            <p>{result.reason}</p>
            <div className="form-actions">
              {session.mode === 'single' ? (
                <>
                  <button className="btn" onClick={() => onExit('rematch')}>再来一局</button>
                  <button className="btn btn-ghost" onClick={() => onExit('menu')}>返回主菜单</button>
                </>
              ) : (
                <>
                  <button className="btn" onClick={() => onExit('room')}>返回房间（可再战）</button>
                  <button className="btn btn-ghost" onClick={() => onExit('lobby')}>离开房间</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* hover 大卡：左下角对齐鼠标进入点，展示完整卡牌信息 */}
      {unitTooltip && (() => {
        const def = CARDS[unitTooltip.unit.cardId];
        if (!def) return null;
        const CARD_W = 152; const CARD_H = 210;
        let x = unitTooltip.x + 14;
        let y = unitTooltip.y - CARD_H;
        if (x + CARD_W > window.innerWidth - 6) x = unitTooltip.x - CARD_W - 14;
        if (y < 6) y = 6;
        return (
          <div className="unit-tooltip" style={{ left: x, top: y }}>
            <div className={`tooltip-card ${def.faction ? `faction-${def.faction}` : 'faction-neutral'}`}>
              <div className="card-cost">{def.cost}</div>
              <SkinImage skinKey={def.art ?? ''} alt={def.name} className="card-art"
                fallback={<span className="card-art-fallback">{def.kind === 'unit' ? '🗡️' : '📜'}</span>} />
              <div className="card-name">{def.name}</div>
              {def.faction && (
                <div className="card-faction" data-tip={FACTION_DEFS[def.faction].desc}>
                  {FACTION_DEFS[def.faction].name}
                </div>
              )}
              <div className="card-desc">{def.desc}</div>
              {def.kind === 'unit' && (
                <div className="card-stats">
                  <span className="stat-atk">{unitTooltip.unit.atk}</span>
                  <span className="stat-hp">{unitTooltip.unit.hp}</span>
                </div>
              )}
              {def.kind === 'unit' && def.keywords && def.keywords.length > 0 && (
                <div className="unit-kws">{def.keywords.map((k) => <KwTag key={k} kw={k} />)}</div>
              )}
              {unitTooltip.unit.buffs.length > 0 && (
                <div className="unit-kws">
                  {unitTooltip.unit.buffs.map((b, bi) => (
                    <span key={bi} className="kw buff" data-tip={CARDS[b.cardId]?.desc ?? ''}>{b.name}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
