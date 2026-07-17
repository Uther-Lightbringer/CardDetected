// ==================== 游戏规则类型 ====================

export type Row = 'front' | 'back';
export type PlayerIndex = 0 | 1;

/** 卡牌关键词 */
export type Keyword = 'guard' | 'charge' | 'infiltrate' | 'ranged';

export interface CardDef {
  id: string;
  name: string;
  cost: number;
  kind: 'unit' | 'spell';
  /** 单位牌属性 */
  atk?: number;
  hp?: number;
  keywords?: Keyword[];
  /** 法术牌效果 */
  effect?:
    | { kind: 'damage'; amount: number } // 需要一个敌方单位目标
    | { kind: 'draw'; amount: number }
    | { kind: 'reveal_hand' }; // 侦测：查看对手全部手牌
  /** 皮肤系统用的图片 key（见 client manifest） */
  art?: string;
  desc: string;
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
  | { type: 'create_room'; name: string }
  | { type: 'join_room'; roomId: string }
  | { type: 'leave_room' }
  | { type: 'start_game' }
  | { type: 'game_action'; action: GameAction };

export type ServerMessage =
  | { type: 'auth_ok'; user: UserProfile }
  | { type: 'error'; code: string; message: string }
  | { type: 'rooms'; rooms: RoomInfo[] }
  | { type: 'room_update'; room: RoomInfo | null }
  | { type: 'game_start'; side: PlayerIndex }
  | { type: 'game_state'; view: GameView; events: GameEvent[] }
  | { type: 'game_over'; winner: PlayerIndex; reason: string };
