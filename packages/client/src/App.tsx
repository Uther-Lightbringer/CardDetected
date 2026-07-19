import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameState, PlayerIndex, RoomInfo, UserProfile } from '@cardetect/shared';
import { WsClient } from './net';
import { CLOUD_MODE, loadSettings, saveSettings, serverUrl, type Settings } from './settings';
import { defaultDeck, lastSave, pushHistory, updateSave, type SaveProfile, type SavedGame } from './saves';
import { LocalAdapter, RemoteAdapter, type BattleAdapter } from './game/adapter';
import Menu from './views/Menu';
import SettingsView from './views/Settings';
import Login from './views/Login';
import Lobby from './views/Lobby';
import Room from './views/Room';
import Battle from './views/Battle';
import Saves from './views/Saves';
import DeckBuilder from './views/DeckBuilder';

type Screen = 'menu' | 'settings' | 'login' | 'lobby' | 'room' | 'battle' | 'saves' | 'decks';

/** 断线重连会话 token 的 localStorage key */
const SESSION_KEY = 'cardetect_session';
/** 重连尝试的总时长（与服务器 RESUME_GRACE_MS 宽限对应） */
const RECONNECT_WINDOW_MS = 60_000;
const RECONNECT_INTERVAL_MS = 3_000;

export interface BattleSession {
  adapter: BattleAdapter;
  mode: 'single' | 'multi';
  myName: string;
  myAvatar: string;
  oppName: string;
  oppAvatar: string;
}

export default function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>('menu');
  const [settings, setSettings] = useState<Settings>(loadSettings());
  const [net, setNet] = useState<WsClient | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [battle, setBattle] = useState<BattleSession | null>(null);
  const [currentSave, setCurrentSave] = useState<SaveProfile | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 当前单人局的上下文：记战绩/清快照用（lastState 由 onStateChange 持续更新） */
  const singleCtxRef = useRef<{ saveId: string; deckName: string; oppName: string; lastState: GameState | null } | null>(null);
  /** 断线重连：下一次 auth_ok 属于 resume（消息处理器据此恢复房间/对局） */
  const resumePendingRef = useRef(false);
  /** 重连循环进行中（防止重复启动） */
  const reconnectingRef = useRef(false);
  // 最新状态的镜像，供 ws 回调等闭包读取
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const userRef = useRef(user);
  userRef.current = user;
  const battleRef = useRef(battle);
  battleRef.current = battle;

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 3200);
  }, []);

  // ---------- 单人游戏 ----------
  const startSingle = useCallback(
    (save: SaveProfile, resume?: SavedGame | null) => {
      if (!CLOUD_MODE && settings.aiProvider === 'deepseek' && !settings.deepseekKey) {
        toast('已选择 Deepseek 但未填写 API Key，请先在设置中配置（本局先用内置机器人）');
      }
      const deck = defaultDeck(save);
      // 云模式：单人固定走服务端 AI 代理（Deepseek），无需任何配置
      const oppName = CLOUD_MODE
        ? 'Deepseek · 云端'
        : settings.aiProvider === 'deepseek' && settings.deepseekKey
          ? `Deepseek · ${settings.deepseekModel}`
          : '内置机器人';
      singleCtxRef.current = { saveId: save.id, deckName: deck.name, oppName, lastState: resume?.state ?? null };
      const adapter = new LocalAdapter(settings, {
        deck: deck.cards,
        seed: resume?.seed,
        resume: resume?.state,
        onStateChange: (state, seed) => {
          // 每次状态变更（含 AI 行动后）把快照写回存档 → 「继续对局」的数据来源
          if (singleCtxRef.current) singleCtxRef.current.lastState = state;
          setCurrentSave((cur) => {
            if (!cur || cur.id !== save.id) return cur;
            const next: SaveProfile = { ...cur, activeGame: { state, seed, savedAt: Date.now() } };
            updateSave(next);
            return next;
          });
        },
      });
      // 函数式更新：保留 exitBattle 刚写入的最新存档（战绩/快照），避免被旧闭包覆盖
      setCurrentSave((cur) => (cur && cur.id === save.id ? cur : save));
      setBattle({
        adapter,
        mode: 'single',
        myName: save.name,
        myAvatar: save.avatar,
        oppName,
        oppAvatar: CLOUD_MODE || (settings.aiProvider === 'deepseek' && settings.deepseekKey) ? 'avatar_7' : 'avatar_5',
      });
      setScreen('battle');
    },
    [settings, toast],
  );

  // ---------- 多人游戏 ----------
  const cleanupNet = useCallback(() => {
    setNet((old) => {
      old?.close();
      return null;
    });
    setUser(null);
    setRoom(null);
    setRooms([]);
    setBattle((old) => {
      old?.adapter.dispose();
      return null;
    });
  }, []);

  /** 放弃重连：清理连接与对局，回主菜单 */
  const giveUpReconnect = useCallback(
    (msg: string) => {
      resumePendingRef.current = false;
      reconnectingRef.current = false;
      toast(msg);
      cleanupNet();
      setScreen('menu');
    },
    [cleanupNet, toast],
  );

  const attachNetListeners = useCallback(
    (client: WsClient) => {
      client.on('auth_ok', (m) => {
        setUser(m.user);
        userRef.current = m.user;
        if (m.token) localStorage.setItem(SESSION_KEY, m.token);
        if (resumePendingRef.current) {
          // resume 成功：等待随后的 room_update（在房间/对局中）或 rooms（无房间）落位
          toast('重连成功');
        } else {
          setScreen('lobby');
          toast(`欢迎，${m.user.username}`);
        }
      });
      client.on('rooms', (m) => {
        setRooms(m.rooms);
        if (resumePendingRef.current) {
          // resume 后不在任何房间：回大厅
          resumePendingRef.current = false;
          setScreen('lobby');
        }
      });
      client.on('room_update', (m) => {
        setRoom(m.room);
        if (m.room === null) {
          setScreen((s) => (s === 'room' ? 'lobby' : s));
          return;
        }
        if (!resumePendingRef.current) {
          // 正常流程：创建/加入/有人加入房间 → 切到房间界面
          // 已在 battle 时不切（对局结束由 exitBattle 控制）；playing 由 game_start 处理
          if (m.room.state === 'waiting') {
            setScreen((s) => (s === 'battle' ? s : 'room'));
          }
          return;
        }
        // 断线重连找回房间：等待中回房间；对局中重建 RemoteAdapter 回战场
        resumePendingRef.current = false;
        const me = userRef.current?.username;
        const side = m.room.players.findIndex((p) => p.username === me);
        if (m.room.state === 'playing' && side >= 0) {
          const opp = m.room.players[side === 0 ? 1 : 0];
          setBattle((old) => {
            old?.adapter.dispose();
            return {
              adapter: new RemoteAdapter(client, side as PlayerIndex),
              mode: 'multi',
              myName: me ?? '你',
              myAvatar: userRef.current?.avatar ?? 'avatar_1',
              oppName: opp?.username ?? '对手',
              oppAvatar: opp?.avatar ?? 'avatar_2',
            };
          });
          setScreen('battle');
        } else {
          setScreen('room');
        }
      });
      client.on('error', (m) => {
        if (m.code === 'bad_token' && resumePendingRef.current) {
          giveUpReconnect('会话已失效，请重新登录');
          return;
        }
        if (m.code !== 'bad_action') toast(m.message);
      });
      client.on('game_start', (m) => {
        setRoom((currentRoom) => {
          const opp = currentRoom?.players[m.side === 0 ? 1 : 0];
          setBattle({
            adapter: new RemoteAdapter(client, m.side),
            mode: 'multi',
            myName: currentRoom?.players[m.side]?.username ?? '你',
            myAvatar: currentRoom?.players[m.side]?.avatar ?? 'avatar_1',
            oppName: opp?.username ?? '对手',
            oppAvatar: opp?.avatar ?? 'avatar_2',
          });
          setScreen('battle');
          return currentRoom;
        });
      });
    },
    [toast, giveUpReconnect],
  );

  /** 断线重连：每 3 秒重试，连上后发 resume；60 秒内未恢复则放弃 */
  const reconnectLoop = useCallback(
    async (token: string) => {
      if (reconnectingRef.current) return;
      reconnectingRef.current = true;
      resumePendingRef.current = true;
      toast('连接断开，重连中…');
      setNet(null); // 旧连接已死，等待新连接接管
      const deadline = Date.now() + RECONNECT_WINDOW_MS;
      while (resumePendingRef.current && Date.now() < deadline) {
        try {
          const client = await WsClient.connect(serverUrl(settings));
          attachNetListeners(client);
          setNet(client);
          client.send({ type: 'resume', token });
          reconnectingRef.current = false;
          return; // 之后由消息处理器接管（room_update / rooms / bad_token）
        } catch {
          await new Promise((r) => setTimeout(r, RECONNECT_INTERVAL_MS));
        }
      }
      if (resumePendingRef.current) giveUpReconnect('重连失败，已返回主菜单');
    },
    [settings, attachNetListeners, giveUpReconnect, toast],
  );

  const handleMultiplayer = useCallback(async () => {
    if (!CLOUD_MODE && (!settings.serverHost || !settings.serverPort)) {
      toast('请先在设置中配置服务器 IP 和端口');
      setScreen('settings');
      return;
    }
    try {
      const client = await WsClient.connect(serverUrl(settings));
      attachNetListeners(client);
      setNet(client);
      setScreen('login');
    } catch {
      toast(CLOUD_MODE ? '无法连接游戏服务器，请稍后再试' : `无法连接服务器 ${settings.serverHost}:${settings.serverPort}，请检查设置或联系服主`);
      if (!CLOUD_MODE) setScreen('settings');
    }
  }, [settings, toast, attachNetListeners]);

  // 断线处理：房间/对局中持有 token 则尝试重连；否则回主菜单（单人局不受服务器断线影响）
  useEffect(() => {
    if (!net) return;
    net.onClose(() => {
      const token = localStorage.getItem(SESSION_KEY);
      const singleBattle = battleRef.current?.mode === 'single';
      const inMatch = screenRef.current === 'room' || screenRef.current === 'battle';
      if (token && inMatch && !singleBattle) {
        void reconnectLoop(token);
        return;
      }
      toast('与服务器断开连接');
      setBattle((old) => {
        if (old?.mode === 'single') return old; // 单人局是本地引擎，不受断线影响
        old?.adapter.dispose();
        return null;
      });
      setNet(null);
      setUser(null);
      setRoom(null);
      setRooms([]);
      if (!singleBattle) setScreen('menu');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net]);

  // ---------- 对战退出 ----------
  const exitBattle = useCallback(
    (dest: 'menu' | 'rematch' | 'room' | 'lobby') => {
      // 单人局收尾：正常结束记战绩并清快照；中途退出保留快照、不记战绩（留给「继续对局」）
      if (battle?.mode === 'single') {
        const ctx = singleCtxRef.current;
        singleCtxRef.current = null;
        const winner = ctx?.lastState?.winner ?? null;
        if (ctx && winner !== null && currentSave && currentSave.id === ctx.saveId) {
          const next: SaveProfile = { ...currentSave, activeGame: null };
          pushHistory(next, {
            at: Date.now(),
            mode: 'single',
            opp: ctx.oppName,
            win: winner === 0,
            turns: ctx.lastState?.turn ?? 0,
            deckName: ctx.deckName,
          });
          setCurrentSave({ ...next });
        }
      }
      // 多人局收尾：正常结束记战绩到最近使用的存档（中途认输离开不记）
      if (battle?.mode === 'multi' && battle.adapter instanceof RemoteAdapter) {
        const res = battle.adapter.result;
        const save = lastSave();
        if (res && save) {
          pushHistory(save, {
            at: Date.now(),
            mode: 'multi',
            opp: battle.oppName,
            win: res.winner === battle.adapter.mySide,
            turns: res.turns,
            deckName: defaultDeck(save).name,
          });
          if (currentSave && currentSave.id === save.id) setCurrentSave({ ...save });
        }
      }
      battle?.adapter.dispose();
      setBattle(null);
      if (dest === 'rematch') {
        if (currentSave) startSingle(currentSave);
        return;
      }
      if (dest === 'lobby') net?.send({ type: 'leave_room' });
      setScreen(dest === 'room' ? 'room' : dest === 'lobby' ? 'lobby' : 'menu');
    },
    [battle, currentSave, net, startSingle],
  );

  const handleExitGame = useCallback(() => {
    cleanupNet();
    setExited(true);
    window.close(); // 浏览器可能阻止，兜底显示告别页
  }, [cleanupNet]);

  if (exited) {
    return (
      <div className="farewell">
        <div className="farewell-card">
          <div style={{ fontSize: 48 }}>🕵️</div>
          <h1>案件告一段落</h1>
          <p>感谢游玩 CardDetect，可以直接关闭此标签页。</p>
          <button className="btn" onClick={() => setExited(false)}>返回主菜单</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {screen === 'menu' && (
        <Menu
          onSingle={() => setScreen('saves')}
          onMulti={handleMultiplayer}
          onSettings={CLOUD_MODE ? undefined : () => setScreen('settings')}
          onExit={handleExitGame}
        />
      )}
      {screen === 'saves' && (
        <Saves
          currentSave={currentSave}
          onSelect={setCurrentSave}
          onStart={(save, resume) => startSingle(save, resume ? save.activeGame : null)}
          onDecks={() => setScreen('decks')}
          onBack={() => setScreen('menu')}
          toast={toast}
        />
      )}
      {screen === 'decks' && currentSave && (
        <DeckBuilder
          save={currentSave}
          onChange={(save) => setCurrentSave({ ...save })}
          onBack={() => setScreen('saves')}
          toast={toast}
        />
      )}
      {screen === 'settings' && (
        <SettingsView
          settings={settings}
          onSave={(s) => {
            setSettings(s);
            saveSettings(s);
            toast('设置已保存');
          }}
          onBack={() => setScreen('menu')}
          toast={toast}
        />
      )}
      {screen === 'login' && net && <Login net={net} onBack={() => { cleanupNet(); setScreen('menu'); }} />}
      {screen === 'lobby' && net && user && (
        <Lobby net={net} rooms={rooms} onLogout={() => { cleanupNet(); setScreen('menu'); }} />
      )}
      {screen === 'room' && net && room && (
        <Room
          net={net}
          room={room}
          me={user?.username ?? ''}
          onLeave={() => net.send({ type: 'leave_room' })}
        />
      )}
      {screen === 'battle' && battle && <Battle session={battle} onExit={exitBattle} toast={toast} />}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  );
}
