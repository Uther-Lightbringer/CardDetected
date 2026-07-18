import assert from 'node:assert';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { buildDefaultDeck, type ClientMessage, type GameView, type RoomInfo, type ServerMessage } from '@cardetect/shared';
import { startServer } from '../src/server.js';

process.env.NO_OPEN = '1';
// 隔离外部环境：AI key 播种走测试内显式配置，保证「初始无 key → 503」的断言成立
delete process.env.DEEPSEEK_API_KEY;
const PORT = 9123;
const STUB_PORT = 9124;
const URL = `ws://127.0.0.1:${PORT}`;

/** 极简测试客户端：按消息类型分发 */
class TestClient {
  ws: WebSocket;
  user: string | null = null;
  token: string | null = null;
  rooms: RoomInfo[] = [];
  room: RoomInfo | null = null;
  side: 0 | 1 | null = null;
  view: GameView | null = null;
  gameOver: { winner: number; reason: string } | null = null;
  private waiters: { type: string; resolve: (m: ServerMessage) => void }[] = [];
  private inbox: ServerMessage[] = []; // 缓冲已到达但未被等待的消息，避免竞态漏接

  constructor(private name: string) {
    this.ws = new WebSocket(URL);
    this.ws.on('message', (d) => this.onMessage(JSON.parse(d.toString()) as ServerMessage));
  }

  private onMessage(m: ServerMessage): void {
    this.inbox.push(m);
    if (m.type === 'auth_ok') {
      this.user = m.user.username;
      this.token = m.token ?? null;
    }
    if (m.type === 'rooms') this.rooms = m.rooms;
    if (m.type === 'room_update') this.room = m.room;
    if (m.type === 'game_start') this.side = m.side;
    if (m.type === 'game_state') this.view = m.view;
    if (m.type === 'game_over') this.gameOver = { winner: m.winner, reason: m.reason };
    let consumed = false;
    this.waiters = this.waiters.filter((w) => {
      if (!consumed && w.type === m.type) {
        w.resolve(m);
        consumed = true;
        return false;
      }
      return true;
    });
    if (consumed) {
      // 已被等待者消费，从缓冲移除
      this.inbox.splice(this.inbox.indexOf(m), 1);
    }
  }

  waitFor(type: ServerMessage['type'], timeoutMs = 5000): Promise<ServerMessage> {
    const hit = this.inbox.findIndex((m) => m.type === type);
    if (hit >= 0) {
      const [m] = this.inbox.splice(hit, 1);
      return Promise.resolve(m);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} 等待 ${type} 超时`)), timeoutMs);
      this.waiters.push({
        type,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  send(m: ClientMessage): void {
    this.ws.send(JSON.stringify(m));
  }

  open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve(); // 连接可能已完成
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} 连接服务器超时`)), 5000);
      this.ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`${this.name} 连接失败: ${e.message}`));
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // 看门狗：任何卡点 60 秒后强制退出并报告
  const watchdog = setTimeout(() => {
    console.error('❌ 看门狗触发：测试卡死');
    process.exit(1);
  }, 60000);

  const dataDir = mkdtempSync(path.join(tmpdir(), 'cardetect-test-'));
  const server = startServer({ port: PORT, dataDir });
  await new Promise((r) => server.on('listening', r));
  console.log('服务器端到端测试');
  console.log('  … 服务器已监听', PORT);

  const A = new TestClient('A');
  const B = new TestClient('B');
  await A.open();
  await B.open();

  // 1. 注册 + 登录
  A.send({ type: 'register', username: '侦探甲', password: 'pass1234', avatar: 'avatar_1' });
  await A.waitFor('auth_ok');
  B.send({ type: 'register', username: '侦探乙', password: 'pass1234', avatar: 'avatar_2' });
  await B.waitFor('auth_ok');
  assert.equal(A.user, '侦探甲');
  assert.equal(B.user, '侦探乙');
  console.log('  ✓ 注册成功（用户名/头像已保存到服务器）');

  // 1.1 错误密码登录应被拒绝
  const C = new TestClient('C');
  await C.open();
  C.send({ type: 'login', username: '侦探甲', password: 'wrong' });
  const loginErr = (await C.waitFor('error')) as Extract<ServerMessage, { type: 'error' }>;
  assert.equal(loginErr.code, 'login_fail');
  C.close();
  console.log('  ✓ 错误密码被拒绝');

  // 1.2 自定义头像校验：非法 avatar 拒绝（bad_avatar），合法 data URL 原样保存
  const H = new TestClient('H');
  await H.open();
  H.send({ type: 'register', username: '头像怪', password: 'pass1234', avatar: 'evil.exe' });
  const avatarErr1 = (await H.waitFor('error')) as Extract<ServerMessage, { type: 'error' }>;
  assert.equal(avatarErr1.code, 'bad_avatar');
  const hugeAvatar = `data:image/png;base64,${'A'.repeat(150_001)}`;
  H.send({ type: 'register', username: '头像怪', password: 'pass1234', avatar: hugeAvatar });
  const avatarErr2 = (await H.waitFor('error')) as Extract<ServerMessage, { type: 'error' }>;
  assert.equal(avatarErr2.code, 'bad_avatar');
  const tinyAvatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  H.send({ type: 'register', username: '头像侠', password: 'pass1234', avatar: tinyAvatar });
  const authH = (await H.waitFor('auth_ok')) as Extract<ServerMessage, { type: 'auth_ok' }>;
  assert.equal(authH.user.avatar, tinyAvatar, '合法 data URL 头像应原样保存下发');
  H.close();
  console.log('  ✓ 自定义头像注册校验（非法拒绝 / 合法 data URL 原样保存）');

  // 2. A 建房，B 应在大厅看到
  A.send({ type: 'create_room', name: '午夜谜案' });
  await A.waitFor('room_update');
  assert.equal(A.room?.name, '午夜谜案');
  await sleep(100);
  assert.equal(B.rooms.length, 1);
  console.log('  ✓ 建房成功，大厅房间列表已广播');

  // 3. B 加入
  B.send({ type: 'join_room', roomId: B.rooms[0].id });
  await B.waitFor('room_update');
  await sleep(100);
  assert.equal(A.room?.players.length, 2);
  console.log('  ✓ 加入房间成功');

  // 4. 非房主不能开始
  B.send({ type: 'start_game' });
  const startErr = (await B.waitFor('error')) as Extract<ServerMessage, { type: 'error' }>;
  assert.equal(startErr.code, 'not_host');

  // 5. 房主开始游戏
  A.send({ type: 'start_game' });
  await A.waitFor('game_start');
  await B.waitFor('game_start');
  await A.waitFor('game_state');
  await B.waitFor('game_state');
  assert.equal(A.side, 0);
  assert.equal(B.side, 1);
  assert.equal(A.view!.me.hand.length, 3); // 先手 3 张
  assert.equal(B.view!.me.hand.length, 4); // 后手 4 张
  assert.equal(A.view!.opp.handCount, 4);
  assert.ok(!('hand' in A.view!.opp), '对手手牌内容不应下发');
  console.log('  ✓ 对局开始，视角隔离正确（手牌互不可见）');

  // 6. 轮流空过直到疲劳分出胜负（验证服务器权威结算 + 回合流转）
  let guard = 0;
  while (!A.gameOver && !B.gameOver && guard < 200) {
    for (const [client, side] of [[A, 0], [B, 1]] as const) {
      if (client.view && client.view.current === side && client.view.winner === null && client.side === side) {
        client.send({ type: 'game_action', action: { type: 'end_turn' } });
        client.view = null;
        await client.waitFor('game_state').catch(() => {});
        break;
      }
    }
    guard++;
    await sleep(20);
  }
  assert.ok(A.gameOver || B.gameOver, '疲劳局应在限定时间内分出胜负');
  console.log(`  ✓ 对局结束（疲劳判定）：${(A.gameOver ?? B.gameOver)!.reason}`);

  // 7. 游戏结束后房间回到等待状态
  await sleep(200);
  assert.equal(A.room?.state, 'waiting');
  console.log('  ✓ 对局结束后房间复位');

  // 8. 管理面板 API（HTTP Basic 鉴权：默认 admin/cardwar）
  const adminHead = { Authorization: `Basic ${Buffer.from('admin:cardwar').toString('base64')}` };
  const noAuth = await fetch(`http://127.0.0.1:${PORT}/api/status`);
  assert.equal(noAuth.status, 401, '无凭据访问 /api/status 应 401');
  const badAuth = await fetch(`http://127.0.0.1:${PORT}/api/status`, {
    headers: { Authorization: `Basic ${Buffer.from('admin:wrong').toString('base64')}` },
  });
  assert.equal(badAuth.status, 401, '错误凭据应 401');
  console.log('  ✓ 管理面板 Basic Auth 拦截生效');
  const status = (await (await fetch(`http://127.0.0.1:${PORT}/api/status`, { headers: adminHead })).json()) as {
    clients: { username: string }[];
    rooms: { name: string; players: string[] }[];
  };
  assert.ok(status.clients.some((c) => c.username === '侦探甲'));
  assert.ok(status.rooms.some((r) => r.name === '午夜谜案' && r.players.length === 2));
  console.log('  ✓ 管理面板 /api/status 数据正确');

  // 8.1 AI 配置管理 + /api/ai/chat 代理（上游用本地桩模拟 deepseek）
  const cfgRes = await (await fetch(`http://127.0.0.1:${PORT}/api/admin/ai-config`, { headers: adminHead })).json() as {
    hasKey: boolean;
    enabled: boolean;
  };
  assert.equal(cfgRes.hasKey, false, '初始应无 key');
  // 未配置 key 时：/api/ai/chat 返回 503，客户端据此回落内置机器人
  const noKey = await fetch(`http://127.0.0.1:${PORT}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(noKey.status, 503, '未配置 key 应 503');
  // 管理面板保存配置（key 指向本地桩），key 不应回传明文
  const stub = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth = req.headers.authorization;
      assert.equal(auth, 'Bearer sk-test-key-123456', '代理应携带配置的 key');
      const parsed = JSON.parse(body) as { model: string; messages: unknown[] };
      assert.equal(parsed.model, 'deepseek-v4-flash');
      assert.ok(Array.isArray(parsed.messages));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"actions":[{"type":"end_turn"}]}' } }] }));
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, r));
  const save = await fetch(`http://127.0.0.1:${PORT}/api/admin/ai-config`, {
    method: 'POST',
    headers: { ...adminHead, 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'sk-test-key-123456', baseUrl: `http://127.0.0.1:${STUB_PORT}`, enabled: true }),
  });
  assert.equal(save.status, 200);
  const saved = (await save.json()) as { hasKey: boolean; keyPreview: string | null; baseUrl: string };
  assert.ok(saved.hasKey && saved.keyPreview && !saved.keyPreview.includes('test-key-123'), 'key 应脱敏回显');
  console.log('  ✓ AI 配置保存/脱敏回显正确');
  const chat = await fetch(`http://127.0.0.1:${PORT}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '该你行动' }], responseFormat: 'json' }),
  });
  assert.equal(chat.status, 200);
  const chatData = (await chat.json()) as { content: string };
  assert.ok(chatData.content.includes('end_turn'), '代理应透传上游 content');
  const badChat = await fetch(`http://127.0.0.1:${PORT}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(badChat.status, 400, '空 messages 应 400');
  // AI 测试接口：不传参用已保存的配置（指向本地桩）应成功；指向死端口应失败但不炸服
  const aiTest = await (await fetch(`http://127.0.0.1:${PORT}/api/admin/ai-test`, {
    method: 'POST',
    headers: { ...adminHead, 'Content-Type': 'application/json' },
    body: '{}',
  })).json() as { ok: boolean; model?: string; latencyMs?: number; reply?: string };
  assert.ok(aiTest.ok, 'ai-test 应成功');
  assert.equal(aiTest.model, 'deepseek-v4-flash', '默认模型应为 deepseek-v4-flash');
  assert.ok(typeof aiTest.latencyMs === 'number' && aiTest.reply?.includes('end_turn'));
  const aiTestFail = await (await fetch(`http://127.0.0.1:${PORT}/api/admin/ai-test`, {
    method: 'POST',
    headers: { ...adminHead, 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:1' }),
  })).json() as { ok: boolean; error?: string };
  assert.equal(aiTestFail.ok, false, '连不上上游应 ok:false');
  assert.ok(aiTestFail.error);
  stub.close();
  console.log('  ✓ /api/ai/chat 代理（限流/校验/透传）正确');

  // 9. 多人带牌组开局：合法牌组正常使用；非法牌组（19 张）报错并兜底默认牌组
  const D = new TestClient('D');
  const E = new TestClient('E');
  await D.open();
  await E.open();
  D.send({ type: 'register', username: '侦探丙', password: 'pass1234', avatar: 'avatar_3' });
  await D.waitFor('auth_ok');
  E.send({ type: 'register', username: '侦探丁', password: 'pass1234', avatar: 'avatar_4' });
  await E.waitFor('auth_ok');
  assert.ok(D.token && E.token, 'auth_ok 应携带重连 token');
  D.send({ type: 'create_room', name: '牌组测试', deck: buildDefaultDeck() });
  await D.waitFor('room_update');
  E.send({ type: 'join_room', roomId: D.room!.id, deck: buildDefaultDeck().slice(0, 19) });
  await E.waitFor('room_update');
  D.send({ type: 'start_game' });
  const deckErr = (await E.waitFor('error')) as Extract<ServerMessage, { type: 'error' }>;
  assert.equal(deckErr.code, 'bad_deck');
  await D.waitFor('game_start');
  await E.waitFor('game_start');
  await D.waitFor('game_state');
  await E.waitFor('game_state');
  console.log('  ✓ 带牌组开局：非法牌组收到 bad_deck 并用默认牌组兜底，对局正常开始');

  // 10. 对局中掉线 → 宽限内 resume 恢复身份与对局，可继续行动
  E.close();
  await sleep(300); // 等服务器处理 close（启动判负宽限定时器）
  const E2 = new TestClient('E2');
  await E2.open();
  E2.send({ type: 'resume', token: E.token! });
  await E2.waitFor('auth_ok');
  await E2.waitFor('room_update');
  await E2.waitFor('game_state');
  assert.equal(E2.user, '侦探丁');
  assert.equal(E2.room?.state, 'playing');
  assert.ok(E2.view, '恢复后应收到对局视角');
  // 轮流结束回合：验证恢复后的连接可以正常 game_action
  D.send({ type: 'game_action', action: { type: 'end_turn' } });
  await D.waitFor('game_state');
  await E2.waitFor('game_state');
  assert.equal(E2.view!.current, 1, '应轮到重连回来的玩家');
  E2.send({ type: 'game_action', action: { type: 'end_turn' } });
  await E2.waitFor('game_state');
  await D.waitFor('game_state');
  assert.equal(D.view!.current, 0);
  console.log('  ✓ 断线重连：resume 恢复对局，game_action 正常');

  // 11. 掉线超过宽限 → 判负（RESUME_GRACE_MS 用环境变量调小）
  process.env.RESUME_GRACE_MS = '500';
  const F = new TestClient('F');
  const G = new TestClient('G');
  await F.open();
  await G.open();
  F.send({ type: 'register', username: '侦探戊', password: 'pass1234', avatar: 'avatar_5' });
  await F.waitFor('auth_ok');
  G.send({ type: 'register', username: '侦探己', password: 'pass1234', avatar: 'avatar_6' });
  await G.waitFor('auth_ok');
  F.send({ type: 'create_room', name: '宽限测试', deck: buildDefaultDeck() });
  await F.waitFor('room_update');
  G.send({ type: 'join_room', roomId: F.room!.id });
  await G.waitFor('room_update');
  F.send({ type: 'start_game' });
  await F.waitFor('game_start');
  await G.waitFor('game_start');
  G.close(); // 掉线且不再回来
  const over = (await F.waitFor('game_over', 5000)) as Extract<ServerMessage, { type: 'game_over' }>;
  assert.equal(over.winner, 0, '对手超时未归，留守方应获胜');
  console.log('  ✓ 掉线超过宽限期判负（RESUME_GRACE_MS=500 覆盖）');

  A.close();
  B.close();
  D.close();
  E2.close();
  F.close();
  server.close();
  clearTimeout(watchdog);
  console.log('\n端到端测试全部通过 ✅');
  process.exit(0);
}

main().catch((e) => {
  console.error('E2E 测试失败:', e);
  process.exit(1);
});
