# 更新日志

版本号五处同步：`package.json`、`extension.json`、`distribution.json`、`server/index.cjs` 的 `VERSION`、`ui/index.html` 的 `PAGE_VERSION`。

每个版本的发布说明在 [`docs/releases/`](docs/releases/)，安装包在 [Releases](https://github.com/yhm138/workbuddy-cloud-sessions/releases)。

## [1.11.1] — 2026-10-23

文档与文案收口，代码只动了一处措辞逻辑。

### 修复
- 结束卡的条数说法按来源区分：**云端最新**说「到这里是全部 N 条」、**本机快照**说「这是本机快照里的 N 条」。之前快照模式也说「全部」，违反项目「绝不让半截快照看起来完整」的约束。
- 快照模式下多一句指引：要看全文，从右上 `⋯` 拉一次云端。
- 诊断区在「探活未回、但已先拉到一次正文」时会读空对象报 `Cannot read properties of null`，现在对缺失字段全部兜底。
- **安装包改用自带的 zip 打包器**（`tools/zip.cjs`）。Info-ZIP 3.0 的 `-UN=UTF8` 会把中央目录偏移写错 6 字节：`unzip` 靠纠错能解，**Python / 7-Zip 直接报 `Bad magic number for central directory`**；不加该参数又会把中文名写成 GBK。现在统一 UTF-8 + 标志位 bit 11，Windows 资源管理器、7-Zip、Python 读出来都是 `安装.bat`。

### 文档
- README 完全重写：hero + 三段式价值主张 + 原生客户端对比表 + 可折叠的技术细节。
- 新增 [ARCHITECTURE.md](docs/ARCHITECTURE.md)（分层、数据形状、service 契约、性能预算）、[TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)（症状索引）、[REVERSE-ENGINEERING.md](docs/REVERSE-ENGINEERING.md)（逆向过程与教训）、[docs/README.md](docs/README.md)（文档地图）。
- 发布说明归档到 `docs/releases/`。
- 重新生成全部演示截图（旧图还带着已删除的输入框）。

## [1.11.0] — 2026-10-23

### 变更
- **面板回归只读**：删掉底部输入框、确认条、草稿、`wb:message:fill` 整条链路。
  宿主的 `wb:message:fill` 语义是「切到新建草稿」，没有目标会话，永远填不进原来那条。
- 正文末尾新增**结束卡**：说明「面板只读」，给出两条出口 —— 回融合会话（同一个 Session）/ 网页版。
- 顶栏按钮文案跟来源走：`回融合会话` / `网页版继续`，点击后进 loading，1.6s 复原。
- 「网页版打开」统一带 toast 提示，另给「复制链接」兜底（宿主不回报 `window.open` 成败）。

### 修复
- `label()` 增加来源兜底表，部署环境缺 `data.js` 映射时不再显示 `workbuddy-mp` 这种原始值。
- 详情页副标题单行省略，窄屏不再把标题栏挤成两行。

## [1.10.0] — 2026-10-23

### 新增
- **流式回放**：`peek` 方法 + 面板 280ms 轮询，第一段正文 1 秒内出现，边拉边画。
- 云端 `updatedAt` 未变时 30 分钟内复用缓存（`ts` 指纹）。
- 悬停 150ms 预取、进面板预热 TLS。

### 修复
- 「回车后原会话输入框是空的」：改为先把话落进本地草稿 + 剪贴板，再跳转（v1.11 起整条链路被移除）。
- 预取的正文被误标成「本机快照」，导致误弹降级提醒。
- 小程序 / App 来源不再被直接送进客户端空页面，先让用户选「网页版 / 回客户端」。

### 性能
- 空闲收尾 4000ms → 1400ms，`session/load` 回执后 700ms。
- 去掉 SSE 后 `sleep(600)`、initialize 后 `sleep(300)` 的规则等待。
- keep-alive Agent 复用连接。假网关实测 4200ms → 830ms。

## [1.9.1] — 2026-10-23

### 修复
- **「拉取失败：缺少 id」**。宿主调 service 方法时第一个参数永远是 context（无 caller 时是 `{callerId: undefined}`，键在值不在），v1.9.0 用值判空判不出来，把 context 当成了 payload。改为按**键是否存在**判断，并加深度的 `resolveId()` 兜底。
- 诊断区新增 `calls`：最近 12 次调用的参数形状。

## [1.9.0] — 2026-10-23

### 新增
- **扩展内 service**：`extension.json` 声明 `service.process = "fork"`，宿主 fork `server/index.cjs`。
- 借 `wb.http.get` 的宿主 cookie 换票据，**不再需要扫码**，也不再依赖 Playwright profile。
- 面板经 `$resolveLocalRpc` + `$invokeLocalRpcFallback` 两跳调用，并发闸门 2、内存缓存 3 分钟。

## [1.8.0] — 2026-10-23

### 新增
- **自动同步**：进面板自动拉云端列表（60 秒节流），新会话顺手补正文，不用再点「同步云端列表」。
- 三路触发：进入面板、窗口聚焦、手动刷新。

## [1.7.0] — 2026-10-23

### 新增
- **Windows 便携安装包**：自带 `node.exe`，解压双击 `安装.bat` 即可，不用装 Node。
- 5 步安装向导：探测扩展目录 → 确认客户端退出 → 扫码登录 → 抓取 → 构建部署。
- 浏览器兜底链：Chrome → Edge → 本机 ms-playwright Chromium → 自带，首次成功后钉死选择。
- `uninstall.bat`，可选是否删除登录态。

---

更早的版本（1.0–1.6）只有 git tag，没有单独发布说明。
