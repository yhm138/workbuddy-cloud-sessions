# workbuddy-cloud-sessions

把 WorkBuddy **桌面端看不见的云端会话**（网页版 / 微信小程序 / 定时任务）搬进侧栏，带完整正文、全文搜索和 Markdown 导出。

> 桌面客户端把 `DesktopCloudTaskEntry` 这个特性开关在打包时写死成 `false`，所以左侧栏永远不请求 `cloud` 空间的会话。
> 本地 `workbuddy.db` 里只有标题这类元数据，**正文一份都没落盘**——它只存在云端，靠 ACP 协议回放。
> 这个项目做的事：用你的登录态把正文抓下来，渲染成一个本地优先的侧栏页面，再装回去。

```
88 条云端会话 · 4283 条消息 · 2491 次工具调用 · 7.7 MB 正文分片
```

---

## 它长什么样

左侧菜单多一项「云端会话」：

- **列表**：按来源分组（网页版 / 微信小程序 / 定时任务），每条带消息条数徽标
- **详情**：用户气泡右对齐、助手左对齐，Markdown 标题 / 列表 / **表格** / 代码块正常渲染；工具调用和思考过程默认折叠，点开看输入输出
- **全文搜索**：跨会话搜正文，命中片段高亮，点进去自动滚到那条消息
- **会话内查找**：Ctrl+F 高亮 + 上/下跳转
- **接着聊**（桌面端独有）：一键把这段对话的上下文填进 WorkBuddy 输入框，直接在客户端接着问
- **导出**：一键复制整条会话为 Markdown，或全量导出成 `.md` 文件
- **收藏 / 排序 / 统计 / 深链**：收藏置顶、按时间或消息数排序、来源分布与 30 天活跃度、`#/s/<id>` 可直接跳到某条会话

---

## 快速开始

前置：Node 18+（抓取需要 22+，因为读 SQLite 用了内置 `node:sqlite`），桌面端已登录过。

```bash
git clone https://github.com/yhm138/workbuddy-cloud-sessions.git
cd workbuddy-cloud-sessions
npm install                      # 装 playwright
npx playwright install chromium  # 拉浏览器内核（用系统 Chrome 可跳过）

node bin/wbcs.js login           # 弹出浏览器，微信扫码一次，登录态长期复用
node bin/wbcs.js all             # 抓取 → 构建 → 装进客户端（约 10 分钟）
```

重启 WorkBuddy，左侧菜单 →「云端会话」。

只想先看看效果、不装扩展：

```bash
node bin/wbcs.js fetch --limit 5
node bin/wbcs.js build
node bin/wbcs.js serve           # 打开 http://127.0.0.1:8787/
```

---

## 命令

| 命令 | 作用 |
| --- | --- |
| `wbcs login` | 扫码登录，登录态存到 `.wbcs/profile`（Playwright 持久 profile） |
| `wbcs list` | 只读本地 DB，列出有哪些云端会话（不联网） |
| `wbcs fetch` | 抓正文，支持 `--limit N` / `--only id1,id2` / `--force` / `--idle 4000` |
| `wbcs build` | 生成 `ui/data.js` + `ui/full/*.js` 分片 + 搜索索引 |
| `wbcs deploy` | 装进 WorkBuddy 扩展目录（自动探测，可 `--dest`） |
| `wbcs export` | 导出 Markdown 到 `export/`（含 INDEX.md） |
| `wbcs serve` | 本地静态预览，`--port` 改端口 |
| `wbcs all` | `fetch` + `build` + `deploy` |

环境变量：

| 变量 | 说明 |
| --- | --- |
| `WBCS_HOME` | 数据目录，默认 `<repo>/.wbcs` |
| `WBCS_DB` | `workbuddy.db` 路径，默认 `~/.workbuddy/workbuddy.db` |
| `WBCS_EXT_DIR` | 扩展目录，跳过自动探测 |
| `WORKBUDDY_RESOURCES_PATH` | WorkBuddy 的 `resources` 目录（客户端自己也用这个变量） |
| `WBCS_DEBUG` | 打印详细诊断 |

---

## 原理（一句话版）

正文不走 REST，走 **ACP（Agent Client Protocol）over HTTP + SSE**：

1. `GET /console/as/conversations/{id}/session` → 拿到消息服务地址 `link` 和沙箱 JWT
2. `GET {link}`，`accept: text/event-stream` 建 SSE 长连接 → **响应头下发 `acp-connection-id`**
3. `POST {link}` 发 `initialize` + `session/load`，历史以 `session/update` 事件回放

最容易踩的坑：不带 `acp-connection-id` 的 POST 一律 `404 connection not found`；SSE 没 ready 就 POST 也一样。

细节、字段、事件类型、扩展加载规则都在 **[docs/PROTOCOL.md](docs/PROTOCOL.md)**。

---

## 数据与隐私

- 登录态、抓取结果、导出文件全部在 `.wbcs/` 和 `export/`，**都已被 `.gitignore` 排除**，不会进仓库
- 全程只读：不改动 WorkBuddy 的数据库，不改动 `app.asar`（改二进制会导致客户端闪退，别试）
- 唯一写入的地方是扩展目录 `<WorkBuddy>/resources/app.asar.unpacked/resources/extensions/cloud-sessions/`
- 抓的是你自己的账号、你自己的会话；请勿把 `.wbcs/` 或 `export/` 分享给别人

---

## 常见问题

**`no_token_401` / 登录态失效**
重新 `wbcs login`。Playwright profile 的 cookie 有有效期，通常能撑很久。

**某条会话点开是空的**
纯定时任务的会话本来就没有对话记录，页面会明确提示。如果提示「正文还没缓存」，说明这条是抓取之后新建的，重跑 `wbcs fetch`（增量，只抓新增）。

**装进客户端后菜单里没有**
`wbcs deploy` 会自动探测安装目录，探测失败时用 `--dest` 手动指定到 `.../app.asar.unpacked/resources/extensions`。装完必须**完全退出**客户端（托盘图标右键退出）再打开。

**能不能连实时同步？**
扩展 iframe 里没有 SSE 能力，宿主桥也不暴露流式接口，所以正文只能靠离线抓取 + 增量刷新。列表页的「刷新」按钮在宿主支持时会尝试走桥（失败会明确告诉你原因）。

**要不要改 `app.asar`？**
不要。客户端启用了 `AsarIntegrityValidation`，改一个字节就可能启动即崩。本项目所有能力都在扩展层和离线数据层完成。

---

## 仓库结构

```
bin/wbcs.js          CLI 入口
src/config.js        路径与平台探测（扩展目录自动发现）
src/db.js            读 workbuddy.db（node:sqlite，只读）
src/auth.js          Playwright 持久登录
src/acp.js           ACP over HTTP + SSE 客户端
src/parse.js         session/update → 扁平面条结构
src/fetch.js         全量抓取（增量、原子落盘）
src/build.js         生成 data.js / 正文分片 / 搜索索引
src/deploy.js        安装为内置扩展
src/serve.js         本地预览服务
src/export.js        Markdown 导出
ui/index.html        扩展页面（零依赖，纯原生 JS）
extension.json       扩展清单
distribution.json    分发清单（builtin + iframe）
docs/PROTOCOL.md     协议与机制逆向笔记
```

---

## 声明

非官方工具，与 WorkBuddy 官方无关，靠逆向客户端行为实现。仅用于读取**自己账号**的历史会话。

如果官方后续开放了云端会话入口，这个项目就该退休了——那才是正确的解法。

MIT License
