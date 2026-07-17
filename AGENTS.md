# AGENTS.md

## 项目概述
现代侦探题材联机 1v1 卡牌游戏。TypeScript monorepo（npm workspaces），无额外构建编排工具。
玩法设计见 `DESIGN.md`；运行方式见 `README.md`。

## 结构
- `packages/shared` — 纯 TS 源码包（`exports` 直接指向 `src/index.ts`，不编译）。
  - `src/types.ts`：游戏状态 + WS 协议（ClientMessage/ServerMessage），改协议必须前后端同步。
  - `src/engine.ts`：规则引擎，纯函数式 `applyAction(state, side, action)` 返回新 state+events；`getView`/`filterEventsFor` 负责信息隐藏。
  - `src/ai.ts`：内置机器人 `botTurn`。
- `packages/server` — Node + express + ws，`tsx` 直接运行 TS。账号存 `data/users.json`（scrypt 哈希，scryptSync 第三参 keylen 必填）。管理面板 `public/admin.html` 轮询 `/api/status`。
- `packages/client` — React 18 + Vite。无路由库，`App.tsx` 用 useState 状态机切屏。
  - `src/game/adapter.ts`：Battle 数据源抽象，单人（LocalAdapter，本地引擎+AI）与多人（RemoteAdapter，WS）实现同一接口。
  - `src/skin.tsx` + `public/assets/skins/default/manifest.json`：皮肤系统，所有图片按 key 引用，缺失自动降级占位，禁止硬编码图片路径。

## 命令
- `npm run test`：引擎单测 + 服务器 E2E（用 ws 模拟双客户端；E2E 占端口 9123，失败残留进程要手动 taskkill）。
- `npm run typecheck` / `npm run build`：提交前必须通过。
- 服务器：`npm run dev:server`（PORT/NO_OPEN 环境变量可调）。

## 约定
- 全 ESM（`"type": "module"`），TS 文件互相 import 带 `.js` 后缀（NodeNext 要求）。
- 引擎不保存对局外的任何状态；随机只用 `createRng(seed)`，保证可复现。
- 注释和 UI 文案用中文。数值/平衡改动同步更新 `DESIGN.md` 第 5 节。
- 不要引入路由/状态管理库，保持依赖最小。
