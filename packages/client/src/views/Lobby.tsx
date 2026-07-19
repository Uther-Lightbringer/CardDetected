import { useState } from 'react';
import type { RoomInfo } from '@cardetect/shared';
import type { WsClient } from '../net';
import { defaultDeck, lastSave } from '../saves';
import { AvatarImage } from '../avatar';

/** 多人建房/加入时附带的牌组：最近使用存档的默认牌组；无存档则不带（服务器兜底） */
function myDeck(): string[] | undefined {
  const save = lastSave();
  return save ? defaultDeck(save).cards : undefined;
}

export default function Lobby({
  net,
  rooms,
  onBack,
  onLogout,
}: {
  net: WsClient;
  rooms: RoomInfo[];
  onBack: () => void;
  onLogout: () => void;
}): JSX.Element {
  const [roomName, setRoomName] = useState('');

  return (
    <div className="page">
      <div className="page-card page-wide">
        <h2 className="page-title">游戏大厅</h2>

        <div className="lobby-create">
          <input
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            placeholder="房间名（可留空）"
            maxLength={20}
          />
          <button className="btn" onClick={() => net.send({ type: 'create_room', name: roomName, deck: myDeck() })}>建立房间</button>
          <button className="btn btn-ghost" onClick={() => net.send({ type: 'list_rooms' })}>刷新</button>
        </div>

        <div className="room-list">
          {rooms.length === 0 && <div className="empty-hint">暂无房间，建立一个吧</div>}
          {rooms.map((r) => (
            <div key={r.id} className="room-item">
              <div className="room-item-info">
                <div className="room-item-name">{r.name}</div>
                <div className="room-item-players">
                  {r.players.map((p) => (
                    <span key={p.username} className="room-player">
                      <AvatarImage avatar={p.avatar} className="avatar-img avatar-sm" />
                      {p.username}
                    </span>
                  ))}
                  {r.players.length < 2 && <span className="room-waiting">等待对手…</span>}
                </div>
              </div>
              <div className="room-item-actions">
                <span className={r.state === 'playing' ? 'tag playing' : 'tag waiting'}>
                  {r.state === 'playing' ? '对战中' : `${r.players.length}/2`}
                </span>
                <button
                  className="btn btn-small"
                  disabled={r.state === 'playing' || r.players.length >= 2}
                  onClick={() => net.send({ type: 'join_room', roomId: r.id, deck: myDeck() })}
                >
                  加入
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="form-actions">
          <button className="btn btn-ghost" onClick={onBack}>? ??</button>
          <button className="btn btn-ghost" onClick={onLogout}>退出登录</button>
        </div>
      </div>
    </div>
  );
}
