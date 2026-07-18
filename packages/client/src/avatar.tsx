import { useRef, useState } from 'react';
import { AVATAR_FALLBACKS, AVATAR_KEYS, SkinImage } from './skin';

/**
 * 自定义头像：上传校验 + canvas 裁剪缩放 + 统一渲染组件。
 * 头像字段统一为字符串：预设 key（avatar_1…avatar_8）或 data URL（data:image/...;base64,...），
 * data URL 直接存服务器 users.json 并随房间广播下发，服务器不建文件存储。
 */

/** 允许的图片格式：后缀与 MIME 双重校验（拒绝 gif 及其他） */
const ALLOWED_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
/** 头像统一输出尺寸（正方形） */
export const AVATAR_SIZE = 128;
const JPEG_QUALITY = 0.85;

/** 校验头像文件；合法返回 null，否则返回中文错误文案（纯函数，可单测） */
export function validateAvatarFile(name: string, type: string, size: number): string | null {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
  if (!ALLOWED_EXT.includes(ext)) return '仅支持 PNG / JPG / WebP 格式的图片';
  if (!ALLOWED_MIME.has(type)) return '图片类型不被支持（仅 PNG / JPG / WebP）';
  if (size > MAX_FILE_SIZE) return '图片文件不能超过 2MB';
  return null;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片无法解析，请换一张试试'));
    img.src = url;
  });
}

/** 校验并处理头像文件：居中裁剪为正方形，缩放到 128×128，导出 JPEG data URL（约 10~30KB） */
export async function processAvatarFile(file: File): Promise<string> {
  const problem = validateAvatarFile(file.name, file.type, file.size);
  if (problem) throw new Error(problem);
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前环境不支持图片处理');
    const side = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 统一头像渲染：data URL 直接 <img>，预设 key 走皮肤系统 + emoji 降级 */
export function AvatarImage({ avatar, className }: { avatar: string; className?: string }): JSX.Element {
  if (avatar.startsWith('data:')) {
    return <img className={className ?? 'avatar-img'} src={avatar} alt="自定义头像" draggable={false} />;
  }
  return (
    <SkinImage
      skinKey={avatar}
      alt={avatar}
      className={className ?? 'avatar-img'}
      fallback={<span className="avatar-emoji">{AVATAR_FALLBACKS[avatar] ?? '👤'}</span>}
    />
  );
}

/** 头像选择器：预设头像网格 + 上传自定义头像（上传项同时充当当前自定义头像的预览） */
export function AvatarPicker({ value, onChange }: { value: string; onChange: (avatar: string) => void }): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const custom = value.startsWith('data:');

  const onFile = async (input: HTMLInputElement): Promise<void> => {
    const file = input.files?.[0];
    input.value = ''; // 允许重复选择同一文件
    if (!file) return;
    const problem = validateAvatarFile(file.name, file.type, file.size);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onChange(await processAvatarFile(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : '头像处理失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="avatar-picker">
      <div className="avatar-grid">
        {AVATAR_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className={value === key ? 'avatar-option selected' : 'avatar-option'}
            onClick={() => {
              setError(null);
              onChange(key);
            }}
          >
            <AvatarImage avatar={key} />
          </button>
        ))}
        <button
          type="button"
          className={custom ? 'avatar-option selected' : 'avatar-option'}
          title="上传自定义头像"
          onClick={() => fileRef.current?.click()}
        >
          {custom ? <AvatarImage avatar={value} /> : <span className="avatar-emoji">📷</span>}
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".png,.jpg,.jpeg,.webp"
        style={{ display: 'none' }}
        onChange={(e) => void onFile(e.currentTarget)}
      />
      {busy && <p className="settings-hint">正在处理头像…</p>}
      {!busy && error && <p className="settings-hint avatar-error">{error}</p>}
      {!busy && !error && <p className="settings-hint">点击 📷 上传自定义头像（PNG/JPG/WebP，≤2MB，自动裁剪为 128×128）</p>}
    </div>
  );
}
