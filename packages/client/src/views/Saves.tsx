import { useState } from 'react';
import { createSave, defaultDeck, deleteSave, loadSaves, setLastSaveId, type SaveProfile } from '../saves';
import { AVATAR_FALLBACKS, AVATAR_KEYS, SkinImage } from '../skin';

/** 本地时间格式化：YYYY-MM-DD HH:mm */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Avatar({ avatar, className }: { avatar: string; className?: string }): JSX.Element {
  return (
    <SkinImage
      skinKey={avatar}
      alt={avatar}
      className={className ?? 'avatar-img'}
      fallback={<span className="avatar-emoji">{AVATAR_FALLBACKS[avatar] ?? '👤'}</span>}
    />
  );
}

/** 单人存档：列表 / 存档主页 / 对战记录（同屏内切换） */
export default function Saves({
  currentSave,
  onSelect,
  onStart,
  onDecks,
  onBack,
  toast,
}: {
  currentSave: SaveProfile | null;
  onSelect: (save: SaveProfile | null) => void;
  onStart: (save: SaveProfile, resume: boolean) => void;
  onDecks: () => void;
  onBack: () => void;
  toast: (msg: string) => void;
}): JSX.Element {
  const [saves, setSaves] = useState<SaveProfile[]>(loadSaves());
  const [view, setView] = useState<'list' | 'home' | 'history'>(currentSave ? 'home' : 'list');
  const [newName, setNewName] = useState('');
  const [newAvatar, setNewAvatar] = useState(AVATAR_KEYS[0]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const reload = (): void => setSaves(loadSaves());

  const create = (): void => {
    const name = newName.trim();
    if (!name) return;
    const p = createSave(name, newAvatar);
    setNewName('');
    reload();
    toast(`存档「${p.name}」已创建`);
  };

  const doDelete = (id: string): void => {
    deleteSave(id);
    if (currentSave?.id === id) onSelect(null);
    setConfirmDeleteId(null);
    reload();
    toast('存档已删除');
  };

  const enter = (save: SaveProfile): void => {
    setLastSaveId(save.id); // 记为最近使用的存档（多人开局带它的默认牌组）
    onSelect(save);
    setView('home');
  };

  // ---------- 存档主页 ----------
  const save = currentSave;
  if (view === 'home' && save) {
    return (
      <div className="page">
        <div className="page-card">
          <h2 className="page-title">{save.name} 的存档</h2>
          <div className="save-home-info">
            <Avatar avatar={save.avatar} className="avatar-img avatar-lg" />
            <div>
              <div className="save-item-sub">创建于 {fmtTime(save.createdAt)}</div>
              <div className="save-item-sub">默认牌组：{defaultDeck(save).name}</div>
              {save.activeGame && <span className="tag playing">对局进行中</span>}
            </div>
          </div>
          <div className="save-home-buttons">
            {save.activeGame && (
              <button className="btn" onClick={() => onStart(save, true)}>
                继续对局
                <span className="btn-sub">保存于 {fmtTime(save.activeGame.savedAt)}</span>
              </button>
            )}
            <button className="btn" onClick={() => onStart(save, false)}>新的对局</button>
            <button className="btn" onClick={onDecks}>牌组管理</button>
            <button className="btn" onClick={() => setView('history')}>对战记录</button>
            <button className="btn btn-ghost" onClick={() => { onSelect(null); setView('list'); }}>返回存档列表</button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- 对战记录 ----------
  if (view === 'history' && save) {
    return (
      <div className="page">
        <div className="page-card page-wide">
          <h2 className="page-title">对战记录 · {save.name}</h2>
          <div className="history-list">
            {save.history.length === 0 && <div className="empty-hint">暂无对战记录</div>}
            {save.history.map((r, i) => (
              <div key={i} className="history-item">
                <span>{fmtTime(r.at)}</span>
                <span>{r.mode === 'single' ? '单人' : '多人'}</span>
                <span>vs {r.opp}</span>
                <span className={r.win ? 'win' : 'lose'}>{r.win ? '胜利' : '失败'}</span>
                <span>{r.turns} 回合</span>
                <span>牌组「{r.deckName}」</span>
              </div>
            ))}
          </div>
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => setView('home')}>返回</button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- 存档列表 ----------
  return (
    <div className="page">
      <div className="page-card page-wide">
        <h2 className="page-title">单人存档</h2>
        <div className="save-list">
          {saves.length === 0 && <div className="empty-hint">还没有存档，先在下方新建一个吧</div>}
          {saves.map((s) => (
            <div key={s.id} className="save-item" onClick={() => enter(s)}>
              <Avatar avatar={s.avatar} />
              <div className="save-item-info">
                <div className="save-item-name">
                  {s.name}
                  {s.activeGame && <span className="tag playing">对局进行中</span>}
                </div>
                <div className="save-item-sub">
                  创建于 {fmtTime(s.createdAt)} · 默认牌组：{defaultDeck(s).name} · 战绩 {s.history.length} 场
                </div>
              </div>
              <button
                className="btn btn-danger btn-small save-del"
                onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(s.id); }}
              >
                删除
              </button>
            </div>
          ))}
        </div>

        <div className="save-new">
          <div className="form-row">
            <label>新建存档</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="输入侦探代号"
              maxLength={16}
            />
          </div>
          <div className="form-row">
            <label>选择头像</label>
            <div className="avatar-grid">
              {AVATAR_KEYS.map((key) => (
                <button
                  key={key}
                  className={newAvatar === key ? 'avatar-option selected' : 'avatar-option'}
                  onClick={() => setNewAvatar(key)}
                >
                  <Avatar avatar={key} />
                </button>
              ))}
            </div>
          </div>
          <div className="form-actions">
            <button className="btn" onClick={create} disabled={!newName.trim()}>创建存档</button>
            <button className="btn btn-ghost" onClick={onBack}>返回主菜单</button>
          </div>
        </div>
      </div>

      {confirmDeleteId && (
        <div className="modal-mask" onClick={() => setConfirmDeleteId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>删除存档</h3>
            <p className="settings-hint">
              确定删除存档「{saves.find((s) => s.id === confirmDeleteId)?.name}」吗？牌组、进行中的对局与战绩将一并清除，无法恢复。
            </p>
            <div className="form-actions" style={{ justifyContent: 'center' }}>
              <button className="btn btn-danger" onClick={() => doDelete(confirmDeleteId)}>确认删除</button>
              <button className="btn btn-ghost" onClick={() => setConfirmDeleteId(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
