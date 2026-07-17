import {
  applyAction,
  botTurn,
  buildStarterDeck,
  CARDS,
  createGame,
  filterEventsFor,
  getView,
  type GameAction,
  type GameEvent,
  type GameState,
  type GameView,
  type PlayerIndex,
} from '@cardetect/shared';
import type { WsClient } from '../net';
import type { Settings } from '../settings';
import { requestDeepseekTurn, resolveAiAction, type AiIntel, type LlmDebugRecord } from '../ai/deepseek';

/** 对战 UI 与数据源之间的桥：单人（本地引擎+AI）与多人（服务器）共用 */
export interface BattleCallbacks {
  onUpdate(view: GameView, events: GameEvent[]): void;
  onGameOver(winner: PlayerIndex, reason: string): void;
  onError(message: string): void;
}

export interface BattleAdapter {
  readonly mySide: PlayerIndex;
  /** Battle 组件挂载时注入回调 */
  hooks: BattleCallbacks;
  act(action: GameAction): void;
  /** 让适配器重发当前状态（组件挂载后调用一次） */
  refresh(): void;
  dispose(): void;
  /** 大模型调试记录（仅单人模式的大模型对手提供） */
  getLlmDebugLog?(): LlmDebugRecord[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ==================== 单人：本地规则引擎 + AI 对手 ====================

export class LocalAdapter implements BattleAdapter {
  readonly mySide: PlayerIndex = 0;
  private readonly aiSide: PlayerIndex = 1;
  hooks: BattleCallbacks = { onUpdate: () => {}, onGameOver: () => {}, onError: () => {} };

  private state: GameState;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private disposed = false;
  private aiRunning = false;
  /** 短期记忆：最近战况摘要，喂给大模型 */
  private recentLog: string[] = [];
  /** 大模型调用调试记录 */
  private debugLog: LlmDebugRecord[] = [];
  /** AI 通过「现场勘查」侦测到的玩家手牌（情报记忆） */
  private aiIntel: AiIntel | null = null;

  getLlmDebugLog(): LlmDebugRecord[] {
    return this.debugLog;
  }

  constructor(private settings: Settings) {
    this.state = createGame(buildStarterDeck(), buildStarterDeck(), Date.now() % 2147483647);
  }

  /** 把事件压缩成战况摘要（供大模型短期记忆使用） */
  private summarize(events: GameEvent[]): void {
    for (const e of events) {
      const who = e.player === this.mySide ? '对手' : '你(AI)';
      if (e.type === 'turn_start') this.recentLog.push(`T${e.turn}`);
      else if (e.type === 'play_card') this.recentLog.push(`${who}打出「${CARDS[e.card as string]?.name ?? e.card}」`);
      else if (e.type === 'attack') {
        this.recentLog.push(`${who}的单位攻击${e.target === 'player' ? '对方玩家' : '单位'}(${e.damage}伤害)`);
      } else if (e.type === 'death') this.recentLog.push(`「${CARDS[e.card as string]?.name ?? e.card}」阵亡`);
      else if (e.type === 'fatigue') this.recentLog.push(`${who}疲劳受伤(${e.damage})`);
      else if (e.type === 'reveal') {
        // AI 侦测成功：把看到的手牌记入情报，下一回合喂给模型
        if (e.player === this.aiSide) this.aiIntel = { turn: this.state.turn, hand: e.hand as string[] };
        this.recentLog.push(`${who}侦测了对手的手牌`);
      }
    }
    this.recentLog = this.recentLog.slice(-12);
  }

  refresh(): void {
    this.push([]);
  }

  act(action: GameAction): void {
    if (this.disposed || this.state.winner !== null) return;
    if (this.state.current !== this.mySide) return;
    const r = applyAction(this.state, this.mySide, action);
    if (!r.ok) {
      this.hooks.onError(r.error);
      return;
    }
    this.state = r.state;
    this.push(r.events);
  }

  private push(events: GameEvent[]): void {
    if (this.disposed) return;
    this.summarize(events);
    this.hooks.onUpdate(getView(this.state, this.mySide), filterEventsFor(events, this.mySide));
    if (this.state.winner !== null) {
      const w = this.state.winner;
      this.hooks.onGameOver(w, w === this.mySide ? '真相大白！你赢了' : '线索中断……AI 获胜');
      return;
    }
    if (this.state.current === this.aiSide && !this.aiRunning) {
      this.aiRunning = true;
      this.timers.push(setTimeout(() => void this.runAi(), 800));
    }
  }

  private async runAi(): Promise<void> {
    if (this.disposed || this.state.winner !== null || this.state.current !== this.aiSide) {
      this.aiRunning = false;
      return;
    }
    let modelActions: GameAction[] | null = null;
    if (this.settings.aiProvider === 'deepseek' && this.settings.deepseekKey) {
      try {
        const turn = await requestDeepseekTurn(
          this.settings.deepseekKey,
          this.settings.deepseekModel,
          this.state,
          this.aiSide,
          this.recentLog,
          (record) => {
            this.debugLog.push(record);
            if (this.debugLog.length > 30) this.debugLog.shift();
          },
          this.aiIntel,
        );
        // 台词先上，再逐步执行动作
        if (turn.comment) this.push([{ type: 'ai_comment', text: turn.comment }]);
        modelActions = [];
        // 逐步翻译执行：卡牌名在执行前一刻解析为当前 handIndex
        for (const raw of turn.actions) {
          if (this.disposed || this.state.winner !== null || this.state.current !== this.aiSide) break;
          const ga = resolveAiAction(raw, this.state, this.aiSide);
          if (!ga) continue;
          const r = applyAction(this.state, this.aiSide, ga);
          if (!r.ok) continue; // 幻觉出的非法动作：跳过
          modelActions.push(ga);
          this.state = r.state;
          this.push(r.events);
          await sleep(500);
        }
      } catch {
        modelActions = null; // 网络/解析失败：落回内置机器人
      }
    }

    // 非大模型模式、或大模型整段翻车时：内置机器人补打
    if (modelActions === null || modelActions.length === 0) {
      if (!this.disposed && this.state.current === this.aiSide && this.state.winner === null) {
        for (const a of botTurn(this.state, this.aiSide)) {
          if (this.disposed || this.state.winner !== null || this.state.current !== this.aiSide) break;
          const r = applyAction(this.state, this.aiSide, a);
          if (!r.ok) continue;
          this.state = r.state;
          this.push(r.events);
          await sleep(500);
        }
      }
    }
    // 兜底：AI 没主动结束回合则强制结束
    if (!this.disposed && this.state.winner === null && this.state.current === this.aiSide) {
      const r = applyAction(this.state, this.aiSide, { type: 'end_turn' });
      if (r.ok) {
        this.state = r.state;
        this.push(r.events);
      }
    }
    this.aiRunning = false;
  }

  dispose(): void {
    this.disposed = true;
    this.timers.forEach(clearTimeout);
  }
}

// ==================== 多人：服务器权威 ====================

export class RemoteAdapter implements BattleAdapter {
  hooks: BattleCallbacks = { onUpdate: () => {}, onGameOver: () => {}, onError: () => {} };
  private offs: (() => void)[] = [];
  private lastView: GameView | null = null;
  private over: { winner: PlayerIndex; reason: string } | null = null;

  constructor(
    private client: WsClient,
    readonly mySide: PlayerIndex,
  ) {
    this.offs.push(
      client.on('game_state', (m) => {
        this.lastView = m.view;
        this.hooks.onUpdate(m.view, m.events);
      }),
      client.on('game_over', (m) => {
        this.over = { winner: m.winner, reason: m.reason };
        this.hooks.onGameOver(m.winner, m.reason);
      }),
      client.on('error', (m) => {
        if (m.code === 'bad_action') this.hooks.onError(m.message);
      }),
    );
  }

  refresh(): void {
    if (this.lastView) this.hooks.onUpdate(this.lastView, []);
    if (this.over) this.hooks.onGameOver(this.over.winner, this.over.reason);
  }

  act(action: GameAction): void {
    this.client.send({ type: 'game_action', action });
  }

  dispose(): void {
    this.offs.forEach((off) => off());
  }
}
