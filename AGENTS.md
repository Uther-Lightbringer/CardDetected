# AGENTS.md

## 项目概述
武侠江湖题材联机 1v1 卡牌游戏（棋手调遣门派高手对战）。TypeScript monorepo（npm workspaces），无额外构建编排工具。
玩法设计、机制术语表、门派设定见 `DESIGN.md`；运行方式见 `README.md`。

## 结构
- `packages/shared` — 纯 TS 源码包（`exports` 直接指向 `src/index.ts`，不编译）。
  - `src/types.ts`：游戏状态 + WS 协议（ClientMessage/ServerMessage），改协议必须前后端同步。
  - `src/keywords.ts`：关键词/门派元数据注册表（KEYWORD_DEFS/FACTION_DEFS），客户端 tooltip 文案唯一来源。
  - `src/data/cards.json`：卡牌数据（新增卡牌只改这里）；`src/cards.ts` 负责加载+启动校验并导出 `CARDS`。
  - `src/engine.ts`：规则引擎，纯函数式 `applyAction(state, side, action)` 返回新 state+events；原子效果走 `EFFECT_HANDLERS` 注册表（新效果=types.ts 加一种 EffectAction + 注册处理器，不改引擎主干）；`getView`/`filterEventsFor` 负责信息隐藏。战场为前锋 6 格 + 后营 3 格（FRONT_SLOTS/BACK_SLOTS）。
  - `src/ai.ts`：内置机器人 `botTurn`。
  - `src/deck.ts`：牌组规则（20 张/同名≤2/单门派+中立）+ `validateDeck`（客户端组牌器与服务器开局校验共用）+ `buildDefaultDeck`。
- `packages/server` — Node + express + ws，`tsx` 直接运行 TS。账号存 `data/users.json`（scrypt 哈希，scryptSync 第三参 keylen 必填；登录签发 token 供断线重连 `resume`，对局中掉线宽限 `RESUME_GRACE_MS`=60s 可用同名环境变量覆盖）。AI 代理配置存 `data/ai-config.json`（`src/aiConfig.ts`，env `DEEPSEEK_API_KEY` 可播种首次启动）。管理面板 `public/admin.html` 轮询 `/api/status`；面板与 `/api/admin/*` 走 HTTP Basic 鉴权（默认 admin/cardwar，`ADMIN_USER`/`ADMIN_PASS` 覆盖）。`POST /api/ai/chat` 是厂商无关的 AI 代理（按 IP 限流 `AI_RATE_PER_MIN`=20），新增模型厂商只改 `aiConfig.ts`。`DATA_DIR` 指定数据目录（Docker 挂卷）。
- `packages/client` — React 18 + Vite。无路由库，`App.tsx` 用 useState 状态机切屏。
  - `src/game/adapter.ts`：Battle 数据源抽象，单人（LocalAdapter，本地引擎+AI）与多人（RemoteAdapter，WS）实现同一接口。LocalAdapter 支持牌组注入与 `resume` 快照恢复，每次状态变更回调 `onStateChange` 供持久化。
  - `src/saves.ts`：单人本地存档 CRUD（localStorage `cardetect_saves`；另有 `cardetect_last_save`/`cardetect_session`）；`src/views/Saves.tsx` 存档选择/主页/战绩，`src/views/DeckBuilder.tsx` 组牌器。
  - `src/skin.tsx` + `public/assets/skins/default/manifest.json`：皮肤系统，所有图片按 key 引用，缺失自动降级占位，禁止硬编码图片路径。

## 命令
- `npm run test`：引擎单测 + 服务器 E2E（用 ws 模拟双客户端；E2E 占端口 9123，失败残留进程要手动 taskkill）。
- `npm run selfplay -w @cardetect/shared -- [局数] [种子]`：AI 自对弈数值报告（先后手胜率/平均回合/单卡胜率），同参数可复现；数值平衡改动前后各跑一次对比。
- `npm run typecheck` / `npm run build`：提交前必须通过。
- 服务器：`npm run dev:server`（PORT/NO_OPEN 环境变量可调）。
- 打包：`npm run dist:client`（Electron portable exe，electron-builder 配置了 electronDist 指向 node_modules 里的 electron 以离线构建；electron 二进制用 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ 下载，本机 GitHub 直连慢）；`npm run dist:server`（esbuild 打包 + Node SEA 注入，build-server.mjs 会把 admin.html 内嵌进 exe；`BUNDLE_ONLY=1` 时只产出 esbuild 单文件，供 Docker 镜像用）。
- 云部署：`npm run deploy`（deploy/deploy.sh：git archive HEAD → ssh 到 aliyun:~/cardetect → docker compose up -d --build，只部署已提交代码）。`docker-compose.yml` 两个容器：server（esbuild 单文件 + node:alpine，暴露 9000 供桌面客户端直连）与 web（vite `VITE_CLOUD=1` 云模式构建 + nginx，暴露 80：静态页 + `/ws`、`/api`、`/admin.html` 反代到 server）。云模式客户端：无设置页，serverUrl 连同源 `/ws`，单人 AI 走同源 `/api/ai/chat`（key 在服务端管理面板配置）。数据持久化在 docker 卷 server-data。
- 本机 shell 里有 `ELECTRON_RUN_AS_NODE=1`（VS Code 继承）：从命令行启动 electron 应用必须先 `env -u ELECTRON_RUN_AS_NODE`，否则表现为静默退出/node 报错。

## 约定
- 全 ESM（`"type": "module"`），TS 文件互相 import 带 `.js` 后缀（NodeNext 要求）。
- 引擎不保存对局外的任何状态；随机只用 `createRng(seed)`，保证可复现。
- 注释和 UI 文案用中文。数值/平衡改动同步更新 `DESIGN.md` 第 5 节。
- 不要引入路由/状态管理库，保持依赖最小。
