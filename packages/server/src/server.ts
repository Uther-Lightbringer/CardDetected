import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  applyAction,
  buildStarterDeck,
  createGame,
  filterEventsFor,
  getView,
  type ClientMessage,
  type GameState,
  type PlayerIndex,
  type RoomInfo,
  type ServerMessage,
  type UserProfile,
} from '@cardetect/shared';
import { UserStore } from './store.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==================== 数据结构 ====================

interface ClientConn {
  ws: WebSocket;
  user: UserProfile | null;
  connectedAt: number;
  roomId: string | null;
}

interface Room {
  id: string;
  name: string;
  host: string; // username
  players: ClientConn[]; // 最多 2 人，join 顺序即座位顺序
  state: 'waiting' | 'playing';
  game: GameState | null;
}

const AVATARS = new Set(Array.from({ length: 8 }, (_, i) => `avatar_${i + 1}`));

// ==================== 服务器 ====================

export interface GameServerOptions {
  port: number;
  dataDir?: string;
}

export function startServer({ port, dataDir }: GameServerOptions): Server {
  const store = new UserStore(path.join(dataDir ?? path.join(__dirname, '..', 'data'), 'users.json'));
  const clients = new Set<ClientConn>();
  const rooms = new Map<string, Room>();
  const startedAt = Date.now();

  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'public')));

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

  const startGame = (room: Room): void => {
    room.state = 'playing';
    room.game = createGame(buildStarterDeck(), buildStarterDeck(), Date.now() % 2147483647);
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
      const avatar = AVATARS.has(m.avatar) ? m.avatar : 'avatar_1';
      const msg = store.register(m.username ?? '', m.password ?? '', avatar);
      if (msg) return err(c.ws, 'register_fail', msg);
      c.user = { username: m.username, avatar };
      send(c.ws, { type: 'auth_ok', user: c.user });
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
      send(c.ws, { type: 'auth_ok', user });
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
      leaveRoom(conn);
      clients.delete(conn);
      broadcastRooms();
    });
  });

  httpServer.listen(port);
  return httpServer;
}
