import { useState } from 'react';
import { WsClient } from '../net';
import { serverUrl, type Settings } from '../settings';

export default function SettingsView({
  settings,
  onSave,
  onBack,
  toast,
}: {
  settings: Settings;
  onSave: (s: Settings) => void;
  onBack: () => void;
  toast: (msg: string) => void;
}): JSX.Element {
  const [form, setForm] = useState<Settings>({ ...settings });
  const [testing, setTesting] = useState(false);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]): void =>
    setForm((f) => ({ ...f, [key]: value }));

  const testConnection = async (): Promise<void> => {
    setTesting(true);
    try {
      const client = await WsClient.connect(serverUrl(form));
      client.close();
      toast(`✅ 连接成功：${form.serverHost}:${form.serverPort}`);
    } catch {
      toast(`❌ 连接失败：${form.serverHost}:${form.serverPort}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-card">
        <h2 className="page-title">设置</h2>

        <section className="settings-section">
          <h3>多人游戏服务器</h3>
          <p className="settings-hint">和其他玩家对战前，需要先连接到对方（或服主）启动的游戏服务器。</p>
          <div className="form-row">
            <label>服务器 IP</label>
            <input
              value={form.serverHost}
              onChange={(e) => set('serverHost', e.target.value.trim())}
              placeholder="例如 127.0.0.1"
            />
          </div>
          <div className="form-row">
            <label>端口</label>
            <input
              type="number"
              value={form.serverPort}
              onChange={(e) => set('serverPort', Number(e.target.value) || 9000)}
            />
          </div>
          <button className="btn btn-small" onClick={testConnection} disabled={testing}>
            {testing ? '测试连接中…' : '测试连接'}
          </button>
        </section>

        <section className="settings-section">
          <h3>单人游戏 AI 对手</h3>
          <div className="form-row">
            <label>AI 类型</label>
            <select
              value={form.aiProvider}
              onChange={(e) => set('aiProvider', e.target.value as Settings['aiProvider'])}
            >
              <option value="builtin">内置机器人（无需联网）</option>
              <option value="deepseek">Deepseek 大模型</option>
            </select>
          </div>
          {form.aiProvider === 'deepseek' && (
            <>
              <div className="form-row">
                <label>Deepseek API Key</label>
                <input
                  type="password"
                  value={form.deepseekKey}
                  onChange={(e) => set('deepseekKey', e.target.value.trim())}
                  placeholder="sk-..."
                />
              </div>
              <div className="form-row">
                <label>模型</label>
                <input
                  value={form.deepseekModel}
                  onChange={(e) => set('deepseekModel', e.target.value.trim())}
                  placeholder="deepseek-chat"
                />
              </div>
              <p className="settings-hint">Key 仅保存在你自己的浏览器本地。大模型出错时会自动用内置机器人兜底。</p>
            </>
          )}
        </section>

        <div className="form-actions">
          <button className="btn" onClick={() => onSave(form)}>保存</button>
          <button className="btn btn-ghost" onClick={onBack}>返回</button>
        </div>
      </div>
    </div>
  );
}
