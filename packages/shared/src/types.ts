// ==================== 游戏规则类型 ====================

export type Row = 'front' | 'back';
export type PlayerIndex = 0 | 1;

/** 门派（职业）：无影楼 / 铁脊山庄 / 五毒教 / 天机阁。无 faction = 中立 */
export type Faction = 'wuying' | 'tieji' | 'wudu' | 'tianji';

/** 卡牌关键词。每个单位必须且只能有一个攻击范围关键词（melee / ranged） */
export type Keyword = 'melee' | 'guard' | 'charge' | 'infiltrate' | 'ranged' | 'stealth';

/** 原子效果。新效果 = 在此处加一种 + 在 engine.ts 的 EFFECT_HANDLERS 注册处理器 */
export type EffectAction =
  | { kind: 'damage'; amount: number } // 需要一个敌方单位目标
  | { kind: 'draw'; amount: number }
  | { kind: 'reveal_hand' } // 识破：查看对手全部手牌
  | { kind: 'pollute'; amount: number } // 下毒：洗 N 张蛊奴进对手牌库
  | { kind: 'purify' } // 驱毒：移除自己牌库中所有蛊奴
  | { kind: 'shuffle_opp_deck' } // 打乱对手牌库顺序
  | { kind: 'damage_per_noise'; amount: number } // 对手牌库每张蛊奴对其造成 N 点伤害
  | { kind: 'reveal_unit' } // 强制翻开一个敌方易容单位（需要一个敌方盖放单位目标）
  | { kind: 'damage_trigger'; amount: number } // 对触发者（触发埋伏的攻击单位）造成伤害
  | { kind: 'self_ready' }; // 翻开时：自身清除休整、本回合可攻击

/** 效果挂载点：触发时机 + 原子效果列表（可组合） */
export interface EffectDef {
  trigger: 'on_play' | 'on_reveal';
  actions: EffectAction[];
}

/** 传功/淬毒（强化牌）：贴附在单位上的持续增益/减益 */
export interface BuffDef {
  atk?: number;
  hp?: number;
  keywords?: Keyword[];
  /** 单位攻击后销毁（如「淬毒短刃」） */
  destroyAfterAttack?: boolean;
}

export interface CardDef {
  id: string;
  name: string;
  cost: number;
  kind: 'unit' | 'spell' | 'buff' | 'trap';
  /** 门派归属；缺省为中立 */
  faction?: Faction;
  /** 衍生牌（如蛊奴）：不进构筑卡池 */
  token?: boolean;
  /** 单位牌属性 */
  atk?: number;
  hp?: number;
  keywords?: Keyword[];
  /** 打出时效果（法术牌必有；单位牌即“战吼”） */
  effects?: EffectDef[];
  /** 强化牌贴附内容（kind === 'buff' 时必有） */
  buff?: BuffDef;
  /** 埋伏牌触发条件与效果（kind === 'trap' 时必有） */
  trap?: { trigger: 'on_opp_attack'; effects: EffectDef[] };
  /** 皮肤系统用的图片 key（见 client manifest） */
  art?: string;
  desc: string;
}

/** 已贴附到单位身上的传功/淬毒 */
export interface AppliedBuff {
  /** 来源卡牌 id（客户端展示用） */
  cardId: string;
  name: string;
  atk: number;
  hp: number;
  keywords: Keyword[];
  destroyAfterAttack: boolean;
}

export interface UnitState {
  uid: number;
  cardId: string;
  name: string;
  atk: number;
  hp: number;
  maxHp: number;
  keywords: Keyword[];
  /** 召唤失调：打出当回合不能攻击 */
  sick: boolean;
  /** 本回合已攻击 */
  attacked: boolean;
  /** 易容盖放：对外伪装为 1/1 路人，攻击/被攻击/被指定时翻开 */
  faceDown: boolean;
  /** 贴附的传功/淬毒列表 */
  buffs: AppliedBuff[];
}

export interface BoardState {
  front: (UnitState | null)[];
  back: (UnitState | null)[];
}

export interface PlayerState {
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  deck: string[]; // cardId 列表
  hand: string[]; // cardId 列表
  fatigue: number;
  board: BoardState;
  /** 埋伏区：盖放的陷阱牌 cardId，长度固定为 TRAP_SLOTS */
  traps: (string | null)[];
}

export interface GameState {
  players: [PlayerState, PlayerState];
  /** 第几回合（从 1 开始，每次切换行动方 +1） */
  turn: number;
  current: PlayerIndex;
  uidCounter: number;
  winner: PlayerIndex | null;
}

export type UnitRef = { row: Row; slot: number };
/** 攻击/法术目标：某个单位 或 玩家脸 */
export type TargetRef = UnitRef | 'player';

export type GameAction =
  | { type: 'play_card'; handIndex: number; row: Row; slot: number; target?: TargetRef }
  | { type: 'attack'; attacker: UnitRef; target: TargetRef }
  | { type: 'end_turn' };

export interface GameEvent {
  type: string;
  [key: string]: unknown;
}

// ==================== 玩家视角（信息隐藏的核心） ====================

export interface OppView {
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  handCount: number;
  deckCount: number;
  board: BoardState;
  fatigue: number;
  /** 对手埋伏数量（不下发具体卡牌） */
  trapCount: number;
}

export interface GameView {
  me: {
    hp: number;
    maxHp: number;
    mana: number;
    maxMana: number;
    hand: string[];
    deckCount: number;
    board: BoardState;
    fatigue: number;
    traps: (string | null)[];
  };
  opp: OppView;
  current: PlayerIndex;
  mySide: PlayerIndex;
  turn: number;
  winner: PlayerIndex | null;
}

// ==================== 联机协议（WebSocket, JSON） ====================

export interface UserProfile {
  username: string;
  avatar: string; // 头像 key，对应客户端皮肤 manifest
}

export interface RoomInfo {
  id: string;
  name: string;
  players: UserProfile[];
  state: 'waiting' | 'playing';
}

export type ClientMessage =
  | { type: 'register'; username: string; password: string; avatar: string }
  | { type: 'login'; username: string; password: string }
  | { type: 'list_rooms' }
  | { type: 'create_room'; name: string; deck?: string[] } // deck 缺省/非法时服务器用默认牌组兜底
  | { type: 'join_room'; roomId: string; deck?: string[] }
  | { type: 'leave_room' }
  | { type: 'start_game' }
  | { type: 'resume'; token: string } // 断线重连：恢复身份与对局
  | { type: 'game_action'; action: GameAction };

export type ServerMessage =
  | { type: 'auth_ok'; user: UserProfile; token?: string } // token 用于断线重连
  | { type: 'error'; code: string; message: string }
  | { type: 'rooms'; rooms: RoomInfo[] }
  | { type: 'room_update'; room: RoomInfo | null }
  | { type: 'game_start'; side: PlayerIndex }
  | { type: 'game_state'; view: GameView; events: GameEvent[] }
  | { type: 'game_over'; winner: PlayerIndex; reason: string };
