# CardDetect · 疑案追凶

现代侦探题材的联机 1v1 卡牌对战游戏。TypeScript 全栈 monorepo。

> 玩法设计文档见 [DESIGN.md](./DESIGN.md)。

## 项目结构

```
packages/
├── shared/    # @cardetect/shared —— 规则引擎、卡牌定义、联机协议、内置机器人（前后端共用）
├── server/    # @cardetect/server —— 游戏服务器：WebSocket + 账号/房间 + 可视化管理面板
└── client/    # @cardetect/client —— 游戏客户端：React + Vite（单人/多人/设置/皮肤系统）
```

## 快速开始

```bash
npm install          # 安装全部依赖（npm workspaces）

npm run dev:server   # 启动游戏服务器（默认端口 9000，自动打开管理面板 http://127.0.0.1:9000/admin.html）
npm run dev:client   # 另开一个终端，启动客户端（http://localhost:5173）
```

## 玩法模式

### 单人游戏
客户端主菜单 → 单人游戏，与 AI 对战。AI 类型在「设置」里选择：
- **内置机器人**：本地贪心策略，无需联网。
- **Deepseek 大模型**：填入自己的 API Key 后，由 `deepseek-chat` 模型决策出牌；
  大模型超时/返回非法动作时自动用内置机器人兜底。Key 仅保存在浏览器 localStorage。

### 多人游戏
1. 一方先启动游戏服务器（`npm run dev:server`），把 `<本机IP>:9000` 告诉对方。
2. 双方客户端在「设置」里填服务器 IP/端口（可点「测试连接」验证），保存。
3. 主菜单 → 多人游戏 → 注册/登录（用户名、密码、头像保存在服务器上）。
4. 大厅里一方「建立房间」，另一方「加入」，房主点击「开始游戏」。
5. 服务器管理面板实时显示在线客户端和房间状态。

## 皮肤系统

所有图片资源通过 key 引用，定义在 `packages/client/public/assets/skins/default/manifest.json`。
把同名图片文件放进该目录即可替换（如 `menu_bg.png`、`avatars/avatar_1.png`、`cards/sniper.png`），
图片缺失时自动显示占位样式，无需改代码。

## 云端部署（Docker）

一台装了 Docker 的 Linux 服务器即可同时托管游戏服务器和 Web 客户端：

```bash
# 本地一键部署（deploy/deploy.sh）：git archive 打包已提交代码 → ssh 传输 → 远端 compose 构建
npm run deploy                          # 默认远端 aliyun、目录 ~/cardetect
DEPLOY_HOST=myserver npm run deploy     # 也可指定其他 ssh 别名
```

也可以直接在服务器上手动操作：`git clone` 后 `docker compose up -d --build`。

部署后：
- **Web 客户端**：`http://<服务器IP>/` —— 与桌面版界面一致，但无「设置」入口（云模式 `VITE_CLOUD=1` 构建）：多人自动连同源 `/ws`（nginx 反代），单人固定使用服务端托管的大模型。
- **管理面板**：`http://<服务器IP>/admin.html`（或 `:9000/admin.html`），HTTP Basic 登录，默认 **admin / cardwar**（`ADMIN_USER`/`ADMIN_PASS` 环境变量可改）。面板可查看在线状态，并可在线修改 **AI 配置**（API Key/模型/接口地址/启停），保存即生效、key 只脱敏回显。
- **桌面版客户端**仍可在设置里填 `<服务器IP>:9000` 直连（9000 端口已暴露）。
- 账号与 AI 配置持久化在 docker 卷 `server-data`（容器内 `/data`）。

AI 代理：客户端单人模式只调服务端 `POST /api/ai/chat`（标准 messages 格式），服务端按配置转发给模型厂商（目前支持 Deepseek，OpenAI 兼容协议）；按 IP 限流（`AI_RATE_PER_MIN`，默认 20 次/分钟）；未配置 key 时返回 503，客户端自动回落内置机器人。首次启动可用 `DEEPSEEK_API_KEY` 环境变量播种 key，之后以管理面板保存的配置为准。

## 打包为 Windows 可执行文件

```bash
npm run dist:client   # 客户端 → packages/client/release/CardDetect x.x.x.exe
                      # （Electron 单文件绿色版，双击即桌面窗口，无控制台）
npm run dist:server   # 服务器 → packages/server/release/CardDetectServer.exe
                      # （Node SEA 单文件，管理面板已内嵌，双击启动并自动打开面板）
```

- 客户端 exe 的皮肤文件保持为普通文件（解包后位于 `resources/app/dist/assets/skins/default/`），直接替换图片即可换肤。
- 服务器 exe 运行时把账号数据写入 **exe 同级目录的 `data/`**。
- 两个 exe 均不依赖 Node.js 环境，可直接拷贝到其他 Windows 机器运行。
- 注意：如果从 VS Code 的集成终端/脚本里启动客户端 exe，需先清除 `ELECTRON_RUN_AS_NODE` 环境变量（直接双击运行不受影响）。

## 测试与检查

```bash
npm run test         # 引擎单元测试（16 个）+ 服务器端到端测试（双客户端全流程）
npm run typecheck    # 三个包的 TypeScript 严格检查
npm run build        # 客户端生产构建
```

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `PORT` | 服务器监听端口 | 9000 |
| `NO_OPEN` | 设为 `1` 时服务器启动不自动打开管理面板 | 自动打开 |
| `DATA_DIR` | 账号/AI 配置文件目录 | `./data` |
| `ADMIN_USER` / `ADMIN_PASS` | 管理面板 Basic Auth 账号密码 | `admin` / `cardwar` |
| `DEEPSEEK_API_KEY` | 首次启动播种 AI key（之后以管理面板为准） | 空 |
| `AI_RATE_PER_MIN` | AI 代理每 IP 每分钟限流 | 20 |
| `VITE_CLOUD` | 客户端构建时设为 `1` 即云模式（无设置页，同源反代） | 关 |

## 当前版本说明（v0.1）

- 规则引擎 v0：前后排战场、近战/远程/护卫/渗透/速攻、法术（伤害/抽牌/侦测）、疲劳机制。
- 双方使用相同预组卡组（22 张）；构筑、陷阱盖放、牌库污染为后续版本（见 DESIGN.md 路线图）。
- 服务器为权威结算，对手手牌/牌库内容不下发客户端（信息隐藏）。
