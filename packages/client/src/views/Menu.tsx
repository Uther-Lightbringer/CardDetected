import { SkinImage } from '../skin';

export default function Menu({
  onSingle,
  onMulti,
  onSettings,
  onExit,
}: {
  onSingle: () => void;
  onMulti: () => void;
  /** 云部署模式（VITE_CLOUD=1）不显示设置入口 */
  onSettings?: () => void;
  onExit: () => void;
}): JSX.Element {
  return (
    <div className="menu-screen">
      <SkinImage
        skinKey="menu_bg"
        alt="主菜单背景"
        className="menu-bg"
        fallback={<div className="menu-bg menu-bg-fallback" />}
      />
      <div className="menu-content">
        <div className="menu-logo">
          <span className="menu-logo-icon">🔍</span>
          <h1>疑案追凶</h1>
          <div className="menu-logo-sub">CARDETECT · 侦探卡牌对战</div>
        </div>
        <div className="menu-buttons">
          <button className="btn btn-menu" onClick={onSingle}>单人游戏</button>
          <button className="btn btn-menu" onClick={onMulti}>多人游戏</button>
          {onSettings && <button className="btn btn-menu" onClick={onSettings}>设　置</button>}
          <button className="btn btn-menu btn-danger" onClick={onExit}>退出游戏</button>
        </div>
      </div>
    </div>
  );
}
