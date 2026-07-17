import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * 皮肤系统：
 * - 皮肤是 public/assets/skins/<name>/ 下的一组图片 + manifest.json
 * - manifest 的 images 字段把「图片 key」映射到图片文件路径
 * - 代码里所有用图都通过 key 引用；图片缺失时自动降级为占位样式
 * - 后续换皮只需替换图片文件/新增皮肤目录，无需改代码
 */
export interface SkinManifest {
  name: string;
  images: Record<string, string>;
}

interface SkinCtx {
  manifest: SkinManifest | null;
  /** 返回图片 URL；manifest 未配置该 key 时返回 null */
  img: (key: string) => string | null;
}

const SKIN_BASE = '/assets/skins/default';

const Ctx = createContext<SkinCtx>({ manifest: null, img: () => null });

export function SkinProvider({ children }: { children: ReactNode }): JSX.Element {
  const [manifest, setManifest] = useState<SkinManifest | null>(null);
  useEffect(() => {
    fetch(`${SKIN_BASE}/manifest.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setManifest)
      .catch(() => setManifest(null));
  }, []);
  const img = (key: string): string | null => {
    const file = manifest?.images?.[key];
    return file ? `${SKIN_BASE}/${file}` : null;
  };
  return <Ctx.Provider value={{ manifest, img }}>{children}</Ctx.Provider>;
}

export function useSkin(): SkinCtx {
  return useContext(Ctx);
}

/** 带降级占位的图片：加载失败/未配置时显示 fallback 内容 */
export function SkinImage({
  skinKey,
  alt,
  className,
  fallback,
}: {
  skinKey: string;
  alt: string;
  className?: string;
  fallback: ReactNode;
}): JSX.Element {
  const { img } = useSkin();
  const [broken, setBroken] = useState(false);
  const url = img(skinKey);
  if (!url || broken) return <div className={`skin-placeholder ${className ?? ''}`}>{fallback}</div>;
  return <img className={className} src={url} alt={alt} onError={() => setBroken(true)} draggable={false} />;
}

/** 预置头像（未配置图片时的 emoji 降级） */
export const AVATAR_FALLBACKS: Record<string, string> = {
  avatar_1: '🕵️',
  avatar_2: '👮',
  avatar_3: '👩‍💼',
  avatar_4: '👨‍🔬',
  avatar_5: '🧔',
  avatar_6: '👱‍♀️',
  avatar_7: '🥷',
  avatar_8: '🤵',
};

export const AVATAR_KEYS = Object.keys(AVATAR_FALLBACKS);
