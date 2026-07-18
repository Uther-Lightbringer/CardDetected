import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  applyAction,
  buildDefaultDeck,
  createGame,
  filterEventsFor,
  getView,
  validateDeck,
  type ClientMessage,
  type GameState,
  type PlayerIndex,
  type RoomInfo,
  type ServerMessage,
  type UserProfile,
} from '@cardetect/shared';
import { UserStore } from './store.js';
import { loadAdminHtml } from './adminHtml.js';
import path from 'node:path';

// ==================== 数据结构 ====================

interface ClientConn {
  ws: WebSocket;
  user: UserProfile | null;
  connectedAt: number;
  roomId: string | null;
  /** 最近一次建房/加入时提交的牌组；缺省或非法时开局用默认牌组兜底 */
  deck?: string[];
}

interface Room {
  id: string;
  name: string;
  host: string; // username
  players: ClientConn[]; // 最多 2 人，join 顺序即座位顺序
  state: 'waiting' | 'playing';
  game: GameState | null;
  /** 本局随机种子（调试用，管理面板可见） */
  seed?: number;
}

const AVATARS = new Set(Array.from({ length: 8 }, (_, i) => `avatar_${i + 1}`));
/** 自定义头像：128×128 JPEG data URL（客户端已裁剪压缩），只认 png/jpeg/webp 三种 MIME */
const AVATAR_DATA_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const AVATAR_DATA_MAX_LEN = 150_000;
/** 头像合法性：预设 key，或尺寸受限的 data URL */
const validAvatar = (a: string): boolean =>
  AVATARS.has(a) || (a.length <= AVATAR_DATA_MAX_LEN && AVATAR_DATA_RE.test(a));

/** 断线重连宽限：对局中掉线后保留座位的时间，超时判负 */
export const RESUME_GRACE_MS = 60_000;
/** 实际生效的宽限时长：环境变量 RESUME_GRACE_MS 可覆盖（测试用） */
const resumeGraceMs = (): number => {
  const v = Number(process.env.RESUME_GRACE_MS);
  return Number.isFinite(v) && v > 0 ? v : RESUME_GRACE_MS;
};

// ==================== 服务器 ====================

export interface GameServerOptions {
  port: number;
  dataDir?: string;
}

export function startServer({ port, dataDir }: GameServerOptions): Server {
  // 数据文件默认放在「启动目录/data」下：exe 双击运行时即 exe 同级目录
  const store = new UserStore(path.join(dataDir ?? path.join(process.cwd(), 'data'), 'users.json'));
  const clients = new Set<ClientConn>();
  const rooms = new Map<string, Room>();
  const startedAt = Date.now();
  /** 对局中掉线玩家的判负定时器：username → timer（resume 成功时清除） */
  const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const app = express();
  const adminHtml = loadAdminHtml();
  app.get(['/', '/admin.html'], (_req, res) => res.type('html').send(adminHtml));

  app.get('/api/status', (_req, res) => {
    res.json({
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      startedAt: new Date(startedAt).toISOString(),
      clients: [...clients].map((c) => ({
        username: c.user?.username ?? '(未登录)',
        avatar: c.user?.avatar ?? '-',
        connectedAt: new Date(c.connectedAt).toISOString(),
        roomId: c.roomId,
        state: c.roomId ? (rooms.get(c.roomId)?.state ?? '-') : '大厅',
      })),
      rooms: [...rooms.values()].map((r) => ({
        id: r.id,
        name: r.name,
        host: r.host,
        players: r.players.map((p) => p.user?.username ?? '?'),
        state: r.state,
        turn: r.game?.turn ?? null,
        seed: r.seed ?? null,
      })),
    });
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  // ---------- 工具 ----------
  const send = (ws: WebSocket, msg: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const err = (ws: WebSocket, code: string, message: string): void => send(ws, { type: 'error', code, message });

  const roomInfo = (r: Room): RoomInfo => ({
    id: r.id,
    name: r.name,
    players: r.players.map((p) => p.user!),
    state: r.state,
  });

  const broadcastRooms = (): void => {
    const msg: ServerMessage = { type: 'rooms', rooms: [...rooms.values()].map(roomInfo) };
    for (const c of clients) if (c.user && !c.roomId) send(c.ws, msg);
  };

  const roomUpdate = (r: Room): void => {
    const msg: ServerMessage = { type: 'room_update', room: roomInfo(r) };
    for (const p of r.players) send(p.ws, msg);
  };

  const leaveRoom = (c: ClientConn, silent = false): void => {
    if (!c.roomId) return;
    const room = rooms.get(c.roomId);
    c.roomId = null;
    if (!room) return;
    // 对局中离开/掉线：对手直接获胜
    if (room.state === 'playing' && room.game && room.game.winner === null) {
      const foe = room.players.find((p) => p !== c);
      if (foe) {
        const winnerSide = room.players.indexOf(foe) as PlayerIndex;
        send(foe.ws, { type: 'game_over', winner: winnerSide, reason: '对手离开了对局，你获胜！' });
      }
    }
    room.players = room.players.filter((p) => p !== c);
    if (room.players.length === 0 || room.host === c.user?.username) {
      // 房主离开 → 解散房间
      for (const p of room.players) {
        p.roomId = null;
        send(p.ws, { type: 'room_update', room: null });
      }
      rooms.delete(room.id);
    } else {
      room.state = 'waiting';
      room.game = null;
      roomUpdate(room);
    }
    if (!silent) broadcastRooms();
  };

  const broadcastGameViews = (room: Room, events: import('@cardetect/shared').GameEvent[]): void => {
    const game = room.game!;
    room.players.forEach((p, i) => {
      const side = i as PlayerIndex;
      send(p.ws, { type: 'game_state', view: getView(game, side), events: filterEventsFor(events, side) });
    });
  };

  /** 取玩家开局牌组：未提交或非法时用默认牌组兜底（非法同时告知提交方） */
  const deckOf = (p: ClientConn): string[] => {
    if (!p.deck) return buildDefaultDeck();
    const problem = validateDeck(p.deck);
    if (problem) {
      err(p.ws, 'bad_deck', `牌组不合法（${problem}），本局已改用默认牌组`);
      return buildDefaultDeck();
    }
    return [...p.deck];
  };

  const startGame = (room: Room): void => {
    room.state = 'playing';
    room.seed = Date.now() % 2147483647;
    room.game = createGame(deckOf(room.players[0]), deckOf(room.players[1]), room.seed);
    room.players.forEach((p, i) => send(p.ws, { type: 'game_start', side: i as PlayerIndex }));
    broadcastGameViews(room, [{ type: 'game_start' }]);
    roomUpdate(room);
    broadcastRooms();
  };

  const endGame = (room: Room, winner: PlayerIndex, reason: string): void => {
    for (const p of room.players) send(p.ws, { type: 'game_over', winner, reason });
    room.state = 'waiting';
    room.game = null;
    roomUpdate(room);
    broadcastRooms();
  };

  // ---------- 消息处理 ----------
  const handlers: { [K in ClientMessage['type']]?: (c: ClientConn, m: Extract<ClientMessage, { type: K }>) => void } = {
    register(c, m) {
      if (c.user) return err(c.ws, 'already_auth', '你已登录');
      if (!validAvatar(m.avatar ?? '')) {
        return err(c.ws, 'bad_avatar', '头像不合法：仅支持预设头像或 PNG/JPG/WebP 图片');
      }
      const avatar = m.avatar;
      const msg = store.register(m.username ?? '', m.password ?? '', avatar);
      if (msg) return err(c.ws, 'register_fail', msg);
      c.user = { username: m.username, avatar };
      const token = randomBytes(16).toString('hex');
      store.setToken(c.user.username, token);
      send(c.ws, { type: 'auth_ok', user: c.user, token });
      send(c.ws, { type: 'rooms', rooms: [...rooms.values()].map(roomInfo) });
    },
    login(c, m) {
      if (c.user) return err(c.ws, 'already_auth', '你已登录');
      const user = store.verify(m.username ?? '', m.password ?? '');
      if (!user) return err(c.ws, 'login_fail', '用户名或密码错误');
      if ([...clients].some((x) => x.user?.username === user.username)) {
        return err(c.ws, 'duplicate', '该账号已在其他地方登录');
      }
      c.user = user;
      const token = randomBytes(16).toString('hex');
      store.setToken(user.username, token);
      send(c.ws, { type: 'auth_ok', user, token });
      send(c.ws, { type: 'rooms', rooms: [...rooms.values()].map(roomInfo) });
    },
    resume(c, m) {
      // 断线重连：凭 token 恢复身份，不受重复登录拦截限制
      if (c.user) return err(c.ws, 'already_auth', '你已登录');
      const user = store.findByToken(m.token ?? '');
      if (!user) return err(c.ws, 'bad_token', '会话已失效，请重新登录');
      c.user = user;
      send(c.ws, { type: 'auth_ok', user, token: m.token });
      // 找回所在房间：把旧连接替换为新连接，恢复座位与对局
      for (const room of rooms.values()) {
        const idx = room.players.findIndex((p) => p.user?.username === user.username);
        if (idx < 0) continue;
        const old = room.players[idx];
        if (old !== c) {
          c.deck = old.deck;
          room.players[idx] = c;
          clients.delete(old);
          old.roomId = null; // 防止旧连接的 close 事件误触发掉线判负
          if (old.ws.readyState === WebSocket.OPEN) old.ws.close();
        }
        c.roomId = room.id;
        const timer = offlineTimers.get(user.username);
        if (timer) {
          clearTimeout(timer);
          offlineTimers.delete(user.username);
        }
        roomUpdate(room);
        if (room.state === 'playing' && room.game) {
          const side = idx as PlayerIndex;
          send(c.ws, { type: 'game_state', view: getView(room.game, side), events: [] });
        }
        broadcastRooms();
        return;
      }
      send(c.ws, { type: 'rooms', rooms: [...rooms.values()].map(roomInfo) });
    },
    list_rooms(c) {
      send(c.ws, { type: 'rooms', rooms: [...rooms.values()].map(roomInfo) });
    },
    create_room(c, m) {
      if (!c.user) return err(c.ws, 'no_auth', '请先登录');
      if (c.roomId) return err(c.ws, 'in_room', '你已在房间中');
      const name = (m.name ?? '').trim().slice(0, 20) || `${c.user.username} 的房间`;
      const id = randomBytes(3).toString('hex');
      c.deck = m.deck;
      const room: Room = { id, name, host: c.user.username, players: [c], state: 'waiting', game: null };
      rooms.set(id, room);
      c.roomId = id;
      send(c.ws, { type: 'room_update', room: roomInfo(room) });
      broadcastRooms();
    },
    join_room(c, m) {
      if (!c.user) return err(c.ws, 'no_auth', '请先登录');
      if (c.roomId) return err(c.ws, 'in_room', '你已在房间中');
      const room = rooms.get(m.roomId);
      if (!room) return err(c.ws, 'no_room', '房间不存在');
      if (room.state !== 'waiting' || room.players.length >= 2) return err(c.ws, 'room_full', '房间已满或正在对局中');
      c.deck = m.deck;
      room.players.push(c);
      c.roomId = room.id;
      roomUpdate(room);
      broadcastRooms();
    },
    leave_room(c) {
      leaveRoom(c);
    },
    start_game(c) {
      const room = c.roomId ? rooms.get(c.roomId) : null;
      if (!room) return err(c.ws, 'no_room', '你不在房间中');
      if (room.host !== c.user?.username) return err(c.ws, 'not_host', '只有房主可以开始游戏');
      if (room.players.length !== 2) return err(c.ws, 'need_players', '需要 2 名玩家才能开始');
      if (room.state === 'playing') return err(c.ws, 'playing', '对局已进行中');
      startGame(room);
    },
    game_action(c, m) {
      const room = c.roomId ? rooms.get(c.roomId) : null;
      if (!room?.game || room.state !== 'playing') return err(c.ws, 'no_game', '对局不存在');
      const side = room.players.indexOf(c) as PlayerIndex;
      if (side < 0) return err(c.ws, 'no_game', '对局不存在');
      const r = applyAction(room.game, side, m.action);
      if (!r.ok) return err(c.ws, 'bad_action', r.error);
      room.game = r.state;
      broadcastGameViews(room, r.events);
      if (r.state.winner !== null) {
        endGame(room, r.state.winner, r.state.winner === side ? '你击溃了对手！' : '对手被击溃！');
      }
    },
  };

  wss.on('connection', (ws) => {
    const conn: ClientConn = { ws, user: null, connectedAt: Date.now(), roomId: null };
    clients.add(conn);
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return err(ws, 'bad_json', '消息格式错误');
      }
      const h = handlers[msg.type] as ((c: ClientConn, m: ClientMessage) => void) | undefined;
      if (!h) return err(ws, 'unknown', '未知消息类型');
      try {
        h(conn, msg);
      } catch (e) {
        console.error('[server] 处理消息异常:', e);
        err(ws, 'internal', '服务器内部错误');
      }
    });
    ws.on('close', () => {
      const room = conn.roomId ? rooms.get(conn.roomId) : null;
      if (room?.state === 'playing' && room.game && room.game.winner === null && conn.user) {
        // 对局中掉线：保留座位等待 resume，宽限期满未归才判负
        const username = conn.user.username;
        const timer = setTimeout(() => {
          offlineTimers.delete(username);
          leaveRoom(conn); // leaveRoom 内含对局中离开的判负逻辑
          broadcastRooms();
        }, resumeGraceMs());
        offlineTimers.set(username, timer);
      } else {
        leaveRoom(conn);
      }
      clients.delete(conn);
      broadcastRooms();
    });
  });

  httpServer.listen(port);
  return httpServer;
}
