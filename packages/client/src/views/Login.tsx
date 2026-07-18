import { useState } from 'react';
import type { WsClient } from '../net';
import { AvatarPicker } from '../avatar';

export default function Login({ net, onBack }: { net: WsClient; onBack: () => void }): JSX.Element {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [avatar, setAvatar] = useState('avatar_1');

  const submit = (): void => {
    if (!username.trim() || !password) return;
    if (mode === 'register') {
      net.send({ type: 'register', username: username.trim(), password, avatar });
    } else {
      net.send({ type: 'login', username: username.trim(), password });
    }
  };

  return (
    <div className="page">
      <div className="page-card">
        <h2 className="page-title">{mode === 'login' ? '登录' : '注册'}侦探档案</h2>
        <div className="tabs">
          <button className={mode === 'login' ? 'tab active' : 'tab'} onClick={() => setMode('login')}>登录</button>
          <button className={mode === 'register' ? 'tab active' : 'tab'} onClick={() => setMode('register')}>注册新账号</button>
        </div>

        <div className="form-row">
          <label>用户名</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="2~16 位" maxLength={16} />
        </div>
        <div className="form-row">
          <label>密码</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 4 位"
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>

        {mode === 'register' && (
          <div className="form-row">
            <label>选择头像</label>
            <AvatarPicker value={avatar} onChange={setAvatar} />
          </div>
        )}

        <div className="form-actions">
          <button className="btn" onClick={submit} disabled={!username.trim() || !password}>
            {mode === 'login' ? '登录' : '注册并登录'}
          </button>
          <button className="btn btn-ghost" onClick={onBack}>返回</button>
        </div>
        <p className="settings-hint">账号信息（用户名/密码哈希/头像）保存在游戏服务器上。</p>
      </div>
    </div>
  );
}
