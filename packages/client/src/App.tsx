import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomInfo, UserProfile } from '@cardetect/shared';
import { WsClient } from './net';
import { loadSettings, saveSettings, serverUrl, type Settings } from './settings';
import { LocalAdapter, RemoteAdapter, type BattleAdapter } from './game/adapter';
import Menu from './views/Menu';
import SettingsView from './views/Settings';
import Login from './views/Login';
import Lobby from './views/Lobby';
import Room from './views/Room';
import Battle from './views/Battle';

type Screen = 'menu' | 'settings' | 'login' | 'lobby' | 'room' | 'battle';

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
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 3200);
  }, []);

  // ---------- 单人游戏 ----------
  const startSingle = useCallback(() => {
    if (settings.aiProvider === 'deepseek' && !settings.deepseekKey) {
      toast('已选择 Deepseek 但未填写 API Key，请先在设置中配置（本局先用内置机器人）');
    }
    const adapter = new LocalAdapter(settings);
    setBattle({
      adapter,
      mode: 'single',
      myName: '你',
      myAvatar: 'avatar_1',
      oppName: settings.aiProvider === 'deepseek' && settings.deepseekKey ? `Deepseek · ${settings.deepseekModel}` : '内置机器人',
      oppAvatar: settings.aiProvider === 'deepseek' && settings.deepseekKey ? 'avatar_7' : 'avatar_5',
    });
    setScreen('battle');
  }, [settings, toast]);

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

  const attachNetListeners = useCallback(
    (client: WsClient) => {
      client.on('auth_ok', (m) => {
        setUser(m.user);
        setScreen('lobby');
        toast(`欢迎，${m.user.username}`);
      });
      client.on('rooms', (m) => setRooms(m.rooms));
      client.on('room_update', (m) => {
        setRoom(m.room);
        if (m.room === null) setScreen((s) => (s === 'room' ? 'lobby' : s));
      });
      client.on('error', (m) => {
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
    [toast],
  );

  const handleMultiplayer = useCallback(async () => {
    if (!settings.serverHost || !settings.serverPort) {
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
      toast(`无法连接服务器 ${settings.serverHost}:${settings.serverPort}，请检查设置或联系服主`);
      setScreen('settings');
    }
  }, [settings, toast, attachNetListeners]);

  // 断线处理：连接意外断开时回到主菜单
  useEffect(() => {
    if (!net) return;
    net.onClose(() => {
      toast('与服务器断开连接');
      setBattle((old) => {
        old?.adapter.dispose();
        return null;
      });
      setNet(null);
      setUser(null);
      setRoom(null);
      setRooms([]);
      setScreen('menu');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net]);

  // ---------- 对战退出 ----------
  const exitBattle = useCallback(
    (dest: 'menu' | 'rematch' | 'room' | 'lobby') => {
      setBattle((old) => {
        old?.adapter.dispose();
        return null;
      });
      if (dest === 'rematch') {
        startSingle();
        return;
      }
      if (dest === 'lobby') net?.send({ type: 'leave_room' });
      setScreen(dest === 'room' ? 'room' : dest === 'lobby' ? 'lobby' : 'menu');
    },
    [net, startSingle],
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
        <Menu onSingle={startSingle} onMulti={handleMultiplayer} onSettings={() => setScreen('settings')} onExit={handleExitGame} />
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
