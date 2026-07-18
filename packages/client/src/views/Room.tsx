import type { RoomInfo } from '@cardetect/shared';
import type { WsClient } from '../net';
import { AvatarImage } from '../avatar';

export default function Room({
  net,
  room,
  me,
  onLeave,
}: {
  net: WsClient;
  room: RoomInfo;
  me: string;
  onLeave: () => void;
}): JSX.Element {
  const isHost = room.players[0]?.username === me;
  const full = room.players.length === 2;

  return (
    <div className="page">
      <div className="page-card">
        <h2 className="page-title">{room.name}</h2>
        <div className="room-slots">
          {[0, 1].map((i) => {
            const p = room.players[i];
            return (
              <div key={i} className="room-slot">
                {p ? (
                  <>
                    <AvatarImage avatar={p.avatar} className="avatar-img avatar-lg" />
                    <div className="room-slot-name">
                      {p.username}
                      {i === 0 && <span className="tag waiting">房主</span>}
                      {p.username === me && <span className="tag me">你</span>}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="avatar-img avatar-lg avatar-empty">?</div>
                    <div className="room-slot-name">等待玩家加入…</div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="form-actions">
          {isHost ? (
            <button className="btn" disabled={!full} onClick={() => net.send({ type: 'start_game' })}>
              {full ? '开始游戏' : '等待对手加入…'}
            </button>
          ) : (
            <p className="settings-hint">等待房主开始游戏…</p>
          )}
          <button className="btn btn-ghost" onClick={onLeave}>离开房间</button>
        </div>
      </div>
    </div>
  );
}
