import {
  applyAction,
  botTurn,
  buildStarterDeck,
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
import { requestDeepseekActions } from '../ai/deepseek';

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

  constructor(private settings: Settings) {
    this.state = createGame(buildStarterDeck(), buildStarterDeck(), Date.now() % 2147483647);
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
    let actions: GameAction[];
    let fromModel = false;
    if (this.settings.aiProvider === 'deepseek' && this.settings.deepseekKey) {
      try {
        actions = await requestDeepseekActions(
          this.settings.deepseekKey,
          this.settings.deepseekModel,
          getView(this.state, this.aiSide),
        );
        fromModel = true;
      } catch {
        actions = botTurn(this.state, this.aiSide);
      }
    } else {
      actions = botTurn(this.state, this.aiSide);
    }

    let succeeded = 0;
    for (const a of actions) {
      if (this.disposed || this.state.winner !== null || this.state.current !== this.aiSide) break;
      const r = applyAction(this.state, this.aiSide, a);
      if (!r.ok) continue; // 大模型幻觉出的非法动作：跳过
      succeeded++;
      this.state = r.state;
      this.push(r.events);
      await sleep(500);
    }
    // 大模型整段翻车时用内置机器人补打
    if (fromModel && succeeded === 0 && !this.disposed && this.state.current === this.aiSide && this.state.winner === null) {
      for (const a of botTurn(this.state, this.aiSide)) {
        if (this.disposed || this.state.winner !== null || this.state.current !== this.aiSide) break;
        const r = applyAction(this.state, this.aiSide, a);
        if (!r.ok) continue;
        this.state = r.state;
        this.push(r.events);
        await sleep(500);
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
