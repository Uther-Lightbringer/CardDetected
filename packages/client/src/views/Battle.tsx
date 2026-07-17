import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CARDS,
  legalTargets,
  type GameEvent,
  type GameState,
  type GameView,
  type PlayerIndex,
  type PlayerState,
  type Row,
  type TargetRef,
  type UnitRef,
  type UnitState,
} from '@cardetect/shared';
import type { BattleSession } from '../App';
import { SYSTEM_PROMPT, type LlmDebugRecord } from '../ai/deepseek';
import { AVATAR_FALLBACKS, SkinImage } from '../skin';

type ExitDest = 'menu' | 'rematch' | 'room' | 'lobby';

/** 用视角数据拼一个引擎可读的伪状态（仅棋盘与胜负字段是真实的） */
function pseudoState(v: GameView): GameState {
  const mk = (hp: number, maxHp: number, board: PlayerState['board']): PlayerState => ({
    hp, maxHp, mana: 0, maxMana: 0, deck: [], hand: [], fatigue: 0, board,
  });
  const meP = mk(v.me.hp, v.me.maxHp, v.me.board);
  const oppP = mk(v.opp.hp, v.opp.maxHp, v.opp.board);
  const players: [PlayerState, PlayerState] = v.mySide === 0 ? [meP, oppP] : [oppP, meP];
  return { players, turn: v.turn, current: v.current, uidCounter: 0, winner: v.winner };
}

const KW_NAMES: Record<string, string> = {
  guard: '护卫', charge: '速攻', infiltrate: '渗透', ranged: '远程',
};

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
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<{ winner: PlayerIndex; reason: string } | null>(null);
  const [revealHand, setRevealHand] = useState<string[] | null>(null);
  const [selectedHand, setSelectedHand] = useState<number | null>(null); // 单位牌选位
  const [spellSource, setSpellSource] = useState<number | null>(null); // 伤害法术选目标
  const [attacker, setAttacker] = useState<UnitRef | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [debugRecords, setDebugRecords] = useState<LlmDebugRecord[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

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
        setView(v);
        handleEvents(events, v);
      },
      onGameOver: (winner, reason) => setResult({ winner, reason }),
      onError: (msg) => toast(msg),
    };
    adapter.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter]);

  const handleEvents = (events: GameEvent[], v: GameView): void => {
    const lines: string[] = [];
    for (const e of events) {
      const who = e.player === v.mySide ? '你' : '对手';
      switch (e.type) {
        case 'turn_start':
          lines.push(`—— 第 ${e.turn} 回合 · ${who}行动 ——`);
          break;
        case 'play_card':
          lines.push(`${who}打出「${CARDS[e.card as string]?.name ?? e.card}」`);
          break;
        case 'attack':
          if (e.target === 'player') lines.push(`${who}的单位直击对方侦探，造成 ${e.damage} 点伤害！`);
          else lines.push(`${who}的单位发起攻击（${e.damage} 伤害${e.counter ? `，被反击 ${e.counter}` : ''}）`);
          break;
        case 'damage':
          lines.push(`「${CARDS[e.source as string]?.name ?? '法术'}」造成 ${e.amount} 点伤害`);
          break;
        case 'death':
          lines.push(`${who}的「${CARDS[e.card as string]?.name ?? e.card}」被消灭`);
          break;
        case 'draw':
          lines.push(e.player === v.mySide ? `你抽了 ${(e.cards as string[]).length} 张牌` : '对手抽了 1 张牌');
          break;
        case 'fatigue':
          lines.push(`${who}牌库已空，疲劳受到 ${e.damage} 点伤害`);
          break;
        case 'burn':
          if (e.player === v.mySide) lines.push(`手牌已满，「${CARDS[e.card as string]?.name ?? e.card}」被烧毁`);
          break;
        case 'reveal':
          setRevealHand(e.hand as string[]);
          lines.push('🔍 你侦测了对手的手牌！');
          break;
        case 'ai_comment':
          lines.push(`🗨 对手：「${e.text}」`);
          break;
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
      toast('法力不足');
      return;
    }
    if (def.kind === 'unit') {
      setSelectedHand(selectedHand === i ? null : i);
      setSpellSource(null);
      setAttacker(null);
    } else if (def.effect?.kind === 'damage') {
      setSpellSource(spellSource === i ? null : i);
      setSelectedHand(null);
      setAttacker(null);
    } else {
      adapter.act({ type: 'play_card', handIndex: i, row: 'front', slot: 0 });
      clearSelection();
    }
  };

  const clickMySlot = (row: Row, slot: number): void => {
    if (!myTurn || !view) return;
    if (selectedHand !== null) {
      if (view.me.board[row][slot]) return;
      adapter.act({ type: 'play_card', handIndex: selectedHand, row, slot });
      clearSelection();
      return;
    }
    const unit = view.me.board[row][slot];
    if (unit && !unit.sick && !unit.attacked) {
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
  }) => {
    if (!unit) {
      return (
        <div className={`slot empty ${opts.highlight ? 'droppable' : ''}`} onClick={opts.onClick}>
          {opts.highlight && <span className="slot-hint">部署</span>}
        </div>
      );
    }
    const def = CARDS[unit.cardId];
    const idle = opts.mine && (unit.sick || unit.attacked);
    return (
      <div
        className={`slot unit ${opts.highlight ? 'targetable' : ''} ${opts.selected ? 'selected' : ''} ${idle ? 'idle' : ''} ${opts.mine && myTurn && !idle ? 'ready' : ''}`}
        onClick={opts.onClick}
        title={def?.desc}
      >
        <SkinImage skinKey={def?.art ?? ''} alt={unit.name} className="unit-art" fallback={<span className="unit-art-fallback">🂠</span>} />
        <div className="unit-name">{unit.name}</div>
        {unit.keywords.length > 0 && (
          <div className="unit-kws">{unit.keywords.map((k) => <span key={k} className="kw">{KW_NAMES[k] ?? k}</span>)}</div>
        )}
        <div className="unit-stats">
          <span className="stat-atk">{unit.atk}</span>
          <span className={unit.hp < unit.maxHp ? 'stat-hp hurt' : 'stat-hp'}>{unit.hp}</span>
        </div>
        {unit.sick && opts.mine && <div className="unit-sick">休整中</div>}
      </div>
    );
  };

  const renderHandCard = (cardId: string, i: number): JSX.Element => {
    const def = CARDS[cardId];
    if (!def) return <div key={i} />;
    const affordable = myTurn && def.cost <= view.me.mana;
    const selected = selectedHand === i || spellSource === i;
    return (
      <div
        key={`${cardId}-${i}`}
        className={`hand-card ${affordable ? '' : 'disabled'} ${selected ? 'selected' : ''}`}
        onClick={() => clickHandCard(i)}
        title={def.desc}
      >
        <div className="card-cost">{def.cost}</div>
        <SkinImage skinKey={def.art ?? ''} alt={def.name} className="card-art" fallback={<span className="card-art-fallback">{def.kind === 'unit' ? '🕵️' : '📜'}</span>} />
        <div className="card-name">{def.name}</div>
        <div className="card-desc">{def.desc}</div>
        {def.kind === 'unit' && (
          <div className="card-stats"><span className="stat-atk">{def.atk}</span><span className="stat-hp">{def.hp}</span></div>
        )}
        {def.kind === 'unit' && def.keywords && def.keywords.length > 0 && (
          <div className="unit-kws">{def.keywords.map((k) => <span key={k} className="kw">{KW_NAMES[k] ?? k}</span>)}</div>
        )}
      </div>
    );
  };

  return (
    <div className="battle">
      <SkinImage skinKey="battle_bg" alt="" className="battle-bg" fallback={<div className="battle-bg menu-bg-fallback" />} />
      <div className="battle-main">
        {/* 对手信息 */}
        <div
          className={`hero-bar opp ${attacker && legal.includes('player') ? 'targetable' : ''}`}
          onClick={clickOppHero}
        >
          <SkinImage skinKey={session.oppAvatar} alt={session.oppName} className="avatar-img" fallback={<span className="avatar-emoji">{AVATAR_FALLBACKS[session.oppAvatar] ?? '👤'}</span>} />
          <div className="hero-info">
            <div className="hero-name">{session.oppName}</div>
            <div className="hero-sub">🃏 {view.opp.handCount} 手牌 · 📚 {view.opp.deckCount} 牌库</div>
          </div>
          <div className="hero-numbers">
            <span className="hp">❤ {view.opp.hp}</span>
            <span className="mana">◆ {view.opp.mana}/{view.opp.maxMana}</span>
          </div>
          {attacker && legal.includes('player') && <span className="attack-hint">可攻击</span>}
        </div>

        {/* 对手棋盘：后排在上 */}
        <div className="board-row opp-row">
          {view.opp.board.back.map((u, i) => (
            <div key={`ob${i}`}>{renderUnit(u, { onClick: () => clickEnemyUnit('back', i), highlight: (spellSource !== null || attacker !== null) && (spellSource !== null || isLegalTarget('back', i)) && !!u })}</div>
          ))}
        </div>
        <div className="board-row opp-row">
          {view.opp.board.front.map((u, i) => (
            <div key={`of${i}`}>{renderUnit(u, { onClick: () => clickEnemyUnit('front', i), highlight: (spellSource !== null || attacker !== null) && (spellSource !== null || isLegalTarget('front', i)) && !!u })}</div>
          ))}
        </div>

        <div className="mid-banner">{myTurn ? '⚡ 你的回合' : '⏳ 对手行动中…'}</div>

        {/* 我的棋盘：前排在上 */}
        <div className="board-row my-row">
          {view.me.board.front.map((u, i) => (
            <div key={`mf${i}`}>{renderUnit(u, { mine: true, onClick: () => clickMySlot('front', i), highlight: selectedHand !== null && !u, selected: !!attacker && attacker.row === 'front' && attacker.slot === i })}</div>
          ))}
        </div>
        <div className="board-row my-row">
          {view.me.board.back.map((u, i) => (
            <div key={`mb${i}`}>{renderUnit(u, { mine: true, onClick: () => clickMySlot('back', i), highlight: selectedHand !== null && !u, selected: !!attacker && attacker.row === 'back' && attacker.slot === i })}</div>
          ))}
        </div>

        {/* 我的信息 */}
        <div className="hero-bar">
          <SkinImage skinKey={session.myAvatar} alt={session.myName} className="avatar-img" fallback={<span className="avatar-emoji">{AVATAR_FALLBACKS[session.myAvatar] ?? '👤'}</span>} />
          <div className="hero-info">
            <div className="hero-name">{session.myName}</div>
            <div className="hero-sub">📚 {view.me.deckCount} 牌库</div>
          </div>
          <div className="hero-numbers">
            <span className="hp">❤ {view.me.hp}</span>
            <span className="mana">◆ {view.me.mana}/{view.me.maxMana}</span>
          </div>
        </div>

        {/* 手牌 */}
        <div className="hand">{view.me.hand.map(renderHandCard)}</div>
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
          {log.map((l, i) => <div key={i} className="log-line">{l}</div>)}
        </div>
      </div>

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
            <h2>{winnerIsMe ? '案件告破！' : '悬案未解…'}</h2>
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
    </div>
  );
}
