# 逆向笔记：WorkBuddy 云端会话是怎么拿到的

这份文档记录实现过程中验证过的事实，方便后来者（或者未来的我）不用再挖一遍 `app.asar`。

结论全部来自对 WorkBuddy 桌面客户端（Electron，Windows）的静态分析和实际抓包，版本时间点：2026-10。

---

## 1. 为什么桌面端看不到云端会话

侧栏的会话列表只请求 `spaces = [local, assistant]`。`cloud` 空间被这个判断挡住：

```js
// app.asar 内（打包后 minify）
g && m && e.push('cloud')
```

其中 `m` 来自一个特性开关：

```js
createProductFeatureHook({
  featureKey: 'DesktopCloudTaskEntry',
  resolve: () => !1        // ← 恒为 false
})
```

第二处门控在同一段逻辑里：

```js
(m || t.transport !== 'cloud') && g.push({ kind: 'independent' })
```

也就是说：**云端会话在桌面端不是"没登录"，而是这个入口被写死关掉了**。改二进制（`!1` → `!0`）可以打开，但客户端启用了 asar 完整性校验，极易启动即崩，不建议。

本地 SQLite `~/.workbuddy/workbuddy.db` 的 `sessions` 表里有 88 条 `transport='cloud'` 的记录，但只有元数据（标题、来源、时间、状态），**没有消息正文**。

---

## 2. 正文在哪：/session 换票 → ACP 回放

### 2.1 换取会话票据

```http
GET https://www.workbuddy.cn/console/as/conversations/{conversationId}/session
accept: application/json
cookie: <网页版登录态>
```

响应：

```json
{
  "data": {
    "link": "https://xxx.agentos-worker.net/acp/...",
    "token": "<sandbox-gateway JWT>",
    "sessionId": "...",
    "sandboxId": "...",
    "acpBackend": "..."
  }
}
```

没登录态时是 `401`（APISIX 网关直接拒）。

### 2.2 建立 ACP 连接

```http
GET {link}
accept: text/event-stream
authorization: Bearer {token}
origin: https://www.workbuddy.cn
x-teams-mode: true
```

响应头里有一个关键字段：

```
acp-connection-id: <uuid>
```

**这个 id 必须回填到后续每个 POST 的 `acp-connection-id` 头**，否则：

```
404 {"error":"connection not found"}
```

### 2.3 握手 + 加载历史

```http
POST {link}
content-type: application/json
authorization: Bearer {token}
acp-connection-id: <上一步响应头里的值>

{"jsonrpc":"2.0","id":0,"method":"initialize","params":{
  "protocolVersion":1,
  "clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},
  "_meta":{"codebuddy.ai":{"question":true,"terminalOutput":true,"terminalOutputChunk":true}}}
}}
```

```json
{"jsonrpc":"2.0","id":1,"method":"session/load",
 "params":{"sessionId":"<id>","cwd":"/workspace","mcpServers":[]}}
```

历史消息从第 2 步建立的 SSE 连接里以 `session/update` 事件流回放。

两个时序坑：

- SSE 连接还没 ready 就 POST → `404 connection not found`
- 服务端要求先 `initialize` 再 `session/load`，中间留 200~300ms

回放**没有结束标记**，只能靠空闲超时收尾（本项目默认 4s）。

---

## 3. 事件结构

一条 SSE 帧：

```json
{"jsonrpc":"2.0","method":"session/update","params":{"update":{...}}}
```

`params.update.sessionUpdate` 的取值：

| 值 | 含义 | 关键字段 |
| --- | --- | --- |
| `user_message_chunk` | 用户消息（流式分片） | `content`, `messageId` |
| `agent_message_chunk` | 助手回复（流式分片） | `content`, `messageId` |
| `agent_thought_chunk` | 思考过程 | `content` |
| `tool_call` | 工具调用开始 | `toolCallId`, `kind`, `title`, `rawInput` |
| `tool_call_update` | 工具状态/输出 | `toolCallId`, `status`, `content`/`rawOutput` |
| `session_info_update` | 会话标题 | `title` |
| `_codebuddy.ai/artifact` | 产物快照 | 噪音，单会话可上万条，**直接丢弃** |

合并规则：同一 `messageId` 的连续 chunk 拼接成一条消息；`tool_call` 与 `tool_call_update` 按 `toolCallId` 配对。

---

## 4. 登录态：为什么不能复用系统 Chrome

Chrome 从 v127 起对 cookie 启用 App-Bound Encryption：cookie 与可执行文件绑定，复制 `User Data` 目录到另一个浏览器实例读不出来，页面会直接跳回微信扫码页。

所以用 Playwright 的 `launchPersistentContext` 维护一个独立 profile，扫一次码长期复用：

```js
chromium.launchPersistentContext('.wbcs/profile', { channel: 'chrome', headless: false })
```

`channel: 'chrome'` 失败（没装 Chrome）时回退 Playwright 自带 Chromium。

登录是否有效，用一条真实会话探测 `/session` 是否返回 `token`，而不是看 URL——URL 停在 `/app` 不代表登录成功。

---

## 5. 扩展是怎么挂进侧栏的

### 5.1 扫描顺序

```
extensions-dev/           source = dev
extensions/               source = installed
app.asar.unpacked/resources/extensions/   source = bundled
```

### 5.2 侧栏位置规则

```js
// main/server.js
placement === 'sidebar'
  ? (kind === 'builtin' ? 'sidebar' : 'more')
  : placement
```

只有 `kind: 'builtin'` 的扩展能真正落到侧栏；其它类型会被塞进「更多」菜单（某些版本布局甚至不渲染这个菜单）。

### 5.3 免签名条件

签名校验只对 `kind === 'builtin' && source !== 'bundled' && !verified && !env` 生效。因此把扩展放进 **bundled 目录**，`kind` 写 `builtin`，就免签名免环境变量。

### 5.4 渲染方式

`distribution.json` 里 `processPolicy.renderer: 'iframe'`，页面以 iframe 加载，`ui.entry.url` 是相对扩展根目录的路径。

iframe 里 **`fetch` / XHR 访问 `file://` 资源会被 CORS 拦**，但 `<script src>` 不受限制。所以数据不是 JSON，而是给 `window` 赋值/回调的 JS 文件：

```js
// ui/data.js
window.CLOUD_SESSIONS = { ... };
// ui/full/<id>.js
window.__WBCS_SESSION__({ id: "...", messages: [...] });
```

正文分片按需注入，首屏只加载列表（几十 KB）和搜索索引。

---

## 6. 宿主桥（iframe ↔ 主进程）

扩展 iframe 被宿主当成一个 **Guest 容器**：先建 MessagePort，再在 port 上做 RPC。
两步缺一不可，第一步没做完界面就是「插件加载失败」。

### 6.0 第一步：guest-ready 握手（漏了它就报「插件加载失败」）

宿主等 iframe 触发 `load`，然后主动推一条 init 消息，并把一个 MessagePort 一并转移进来：

```js
iframe.contentWindow.postMessage(
  { type: '__wb_port_init__', readyToken: '<32 位 hex>' },
  'wb-extension://<extensionId>',
  [port2]
);
```

这个 `port2` 是之后**唯一**的 RPC 通道。guest 必须在 **10 秒**内回一条：

```js
port2.postMessage({
  type: 'wb:invoke:request',
  requestId: 'ready-1',
  channel: 'wb:boundary:guest-ready',
  args: [{ readyToken }]          // 必须与 init 里收到的完全一致
});
```

没回、回晚了、token 不对，宿主都会判失败：

```
Guest Ready timed out after 10000ms: cloud-sessions
→ 界面：「插件加载失败 / 请检查网络后重新加载」
```

这句话**跟网络没关系**，纯粹是 guest 没在 10s 内报到。
本项目把这段代码放在 `<head>` 里（`ui/index.html` 顶部那个 IIFE），实测 6ms 完成。

> 老版本笔记里记的 `window.parent.postMessage({ type:'wb:handshake:request' })`
> 在 1.0.x 桌面端**已经没人监听**了（那条 transport 只用于 webview）。
> 只发它等于什么都没做：握手超时 + 后续所有 `wb:*` 调用全部失败。

握手之后 port 上的消息格式：

```js
// guest → host：调用宿主能力
{ type: 'wb:invoke:request', requestId, channel: 'wb:http:get', args: [url, options] }
// host → guest：结果 / 错误
{ type: 'wb:invoke:response', requestId, result }
{ type: 'wb:invoke:response', requestId, error: { message, code } }
// host → guest：推送事件（wb:conversation:* 等）
{ type: 'wb:event', event, payload }
```

宿主侧 `assertAuthorized` 会校验 subject（来自扩展清单的 `grantedPermissions`）。

扩展 iframe 能用的通道比想象中窄。实测（v1.0.3）：

| 通道 | 扩展 iframe | 原因 |
| --- | --- | --- |
| `wb:config:get` | ✅ 能用 | 授权表里标 `public`，读 `theme` / `language` |
| `wb:http:get` 等 | ✅ 能用 | `http` 命名空间在转发白名单里 |
| `wb:shell:openExternal` | ❌ 必被拒 | 见下，subject 类型不对 |
| `wb:message:fill` | ❌ 调不到 | 属于 custom-menu 的 embed 通道，注释见下 |

**`wb:shell:openExternal` 为什么必然失败**

`main/rpc-connection.js` 里的授权判定是硬编码的：

```js
function checkAuthorizationSimplified(channel, subject) {
  if (subject.type === "window" && subject.moduleId === "main"
   || channel === "wb:shell:openExternal" && subject.type === "window" && subject.kind === "builtin"
   || ...) return;                      // 放行
  const e = Error(`[wb.shell] ${channel} denied for subject ${subject.moduleId} (type=${subject.type}); …`);
  e.code = "PERMISSION_DENIED";
  return e;
}
```

而扩展 iframe 的 subject 是 `extension-mount` 里写死的：

```js
{ moduleId: <extensionId>, type: "extension", kind: "builtin", scopes: [], instanceId: "iframe:…" }
```

`type` 永远是 `extension`，不是 `window` —— 所以 `PERMISSION_DENIED`，没有绕过的余地。

**替代方案（本项目采用）**：直接在 iframe 里 `window.open(url, "_blank")`。
主窗口的 `setWindowOpenHandler` 对普通 URL 的处理正好是：

```js
[WindowManager] Denying window.open, opening externally: <url>
→ action: "deny" + shell.openExternal(url)
```

iframe 的 sandbox 带 `allow-popups`，点击有用户手势，所以这条等于「用系统浏览器打开」，
观察本地日志能看到 `[WindowManager] Denying window.open, opening externally`。

**`wb:message:fill` 是另一回事：它其实调得通**

它确实不在 main 的通道表里（`main/rpc-connection.js` 里没有 `wb:message:*`），只存在于 renderer 的
`createEmbedMessageInvoke`。一开始据此判定「扩展 iframe 到不了那一层」，是**错的**：
扩展 iframe 和自定义菜单同在**主窗口渲染进程**，请求在渲染进程就被接住了，压根没往 main 转发
（证据：调用返回成功，`main.log` / `renderer.log` 里都没有 `NO_HANDLER`）。
细节见 [6.2](#62-wbmessagefill-的参数与真实语义)。

`wb:account:token` 在自定义菜单表面被标为 `host-only`，扩展侧拿不到账号 token。

### 6.1 会话列表的 REST 接口（可用于在线同步）

```http
GET https://www.workbuddy.cn/console/as/conversations/?page_size=20&page=1
accept: application/json
```

响应：

```json
{
  "code": 0, "msg": "OK",
  "data": {
    "conversations": [
      { "id": "...", "name": "标题", "status": "completed",
        "conversationOrigin": "agents",
        "createdAt": "...", "updatedAt": "...",
        "manifest": { "envs": [{ "key": "CLIENT_INFO_USER_AGENT_EXTENSION", "value": "agents" }] } }
    ],
    "total": 88,
    "pagination": { "page": 1, "size": 20, "total": 88, "totalPages": 5, "hasNext": true }
  }
}
```

注意：

- 必须有结尾斜杠，`/conversations`（无斜杠）返回 `403 not_authorized`
- 分页是页码式（`page`），`page_size` 实测上限 20
- 来源可从 `conversationOrigin` 或 `manifest.envs` 里的 `CLIENT_INFO_USER_AGENT_EXTENSION` 读到

扩展里点「同步」就是循环翻页拿这个列表，合并进本地快照；正文仍需离线抓取，所以新会话会显示「未缓存」。

### 6.2 `wb:message:fill` 的参数与真实语义

> 这里踩过一次「以为不行」。早期版本发现主进程通道表里没有这个通道，就判定扩展 iframe 调不到，
> 直接降级成复制。实际调用后**返回成功、日志里也没有 `NO_HANDLER`** —— 说明它是在**渲染进程**
> 被 `createEmbedMessageInvoke` 接住了，根本没转发到 main。所以扩展 iframe 是能用的。

```js
Bridge.invoke('wb:message:fill', [{
  content: [{ type: 'text', text: '...' }],  // 也接受裸字符串
  source: 'cloud-sessions',                  // 可选，只进埋点
  // mode / scene 可选，必须是非空字符串
}])
```

解析代码（`renderer` 的 `createEmbedMessageInvoke`）要求 `args[0]` 是对象、非数组，
`content` 是「非空字符串」或「非空 ContentBlock[]」，每个 block 必须有 `type`；
`text` block 还必须带非空 `text`。不满足会抛 `INVALID_ARGUMENT`。

**它到底做了什么：**

```js
markClientMenuTransientLeave();                 // 标记"临时离开"，好让面板收起时不被销毁
Xv.next({ sidebarUrl: '', contentBlocks, source });  // 推给主窗口 composer 的事件流
```

`Xv` 是主渲染进程里的 composer 事件流，消费方是**主窗口底部的输入框**。由此推出三条重要结论：

1. 它**不会**关掉当前面板、**不会**切页面、**不会**给任何可见反馈 —— 调用方必须自己提示用户。
2. 内容落在「当前 / 新建会话」的草稿里。实测点击时 `currentConversationId` 从原值变成 `null`，
   即宿主顺手把你切到了一个新会话草稿；关掉面板回到对话页，输入框里就是那段文本。
3. 如果那一刻 composer 没挂载（比如主窗口停在非对话页），事件就没人接，**静默丢失且不报错**。
   所以一定要留「复制到剪贴板」的兜底。

语义是**填入输入框，不自动发送**（`wb:message:send` 才会发）。

### 6.2.1 想「回到原会话继续」就得用深链，别搬上下文

`workbuddy://chat/<conversationId>` 就是「打开这条会话」。两处证据：

```js
// renderer/assets/main-tRyu8TK6.js —— 定时任务产物深链就是这么干的
let o = `workbuddy://chat/${encodeURIComponent(taskId)}`;
n.openConversation(o);

// 同一文件 handleDesktopOpenUrl：host 命中"业务 host"时 → y(e) → openConversation
if (Nt(n.host) || Ot(n) && Pt(n)) { y(e); return true; }
```

协议已在本机注册（Windows，用户级即可）：

```
HKCU\Software\Classes\workbuddy
  (default) = "URL:workbuddy"
  shell\open\command (default) = "D:\Software\WorkBuddy\WorkBuddy.exe" "%1"
```

所以扩展 iframe 里 `window.open("workbuddy://chat/<id>")` 的完整链路是：

```
iframe window.open(自定义协议)
  → 主窗口 setWindowOpenHandler：非本地文件路径 → shell.openExternal(url)   // 没有协议白名单
  → ShellExecute → WorkBuddy.exe "<url>"（HKCU 注册项）
  → 已在运行 → second-instance → DeepLinkRouter.handleUrl → 渲染进程 openConversation
  → 主窗口跳到那条会话（同一个 Session，历史还在）
```

两个坑：

- `window.open` 对自定义协议**返回 null**，不能拿返回值判断成败；只能看面板有没有被页面切换带走。
  所以要点完后延时再提示一句「没跳过去就用网页版」。
- 深链只对**客户端已有的会话**有效。纯云端的会话（比如只在网页版存在的）跳过去可能停在列表页，
  这种情况老老实实用 `https://www.workbuddy.cn/app/conversation/<id>` 在浏览器里接着聊。

---

## 6.3 为什么热更新扩展会「插件加载失败」

这是踩过的最贵的坑，值得单列。

同一句兜底文案（「插件加载失败 / 请检查网络后重新加载」）其实有**两个**完全不同的原因：

| 现象（看客户端日志） | 真因 | 处理 |
| --- | --- | --- |
| 面板空白 / 资源取不到 | 运行期替换了扩展目录，宿主仍按启动快照取文件 | 托盘退出后重开 |
| `Guest Ready timed out after 10000ms: <id>` | guest 没在 10s 内回 `wb:boundary:guest-ready` | 见 [6.0](#60-第一步guest-ready-握手漏了它就报插件加载失败) |

第一种是宿主的快照机制，第二种是扩展自己的代码问题——**两者都会落到同一句"请检查网络"上**，所以先看日志再动手。

下面是第一种的细节。

宿主对 **bundled（内置）** 扩展的处理是「启动时扫一遍，把清单和文件快照缓起来」。证据是页面 URL：

```
wb-extension://cloud-sessions/ui/index.html?v=0.1.0&wbs=bundled:382
```

- `v` = **启动那一刻** `extension.json` 里的版本，不是磁盘当前版本
- `wbs=bundled:<n>` = 本次启动的扫描代号，每次启动 +1

所以只要在客户端运行期间替换扩展目录（哪怕只是换了 `ui/index.html`），就会出现：

1. 宿主仍按旧清单给页面打 `?v=0.1.0`，并按旧快照去 `wb-extension://` 取文件
2. 磁盘上的文件已经换了一版（比如 `data.js` 的数据结构变了），取到的内容对不上
3. 面板不再渲染，宿主显示兜底文案「插件加载失败 / 请检查网络后重新加载」

**这条文案是网络口径的，但跟网络一点关系都没有**，所以第一次查会往网络/代理方向跑偏。
实测把 `?v=` 和磁盘版本放在一起看，一眼就能确认：客户端 22:50 启动、23:40 才部署，日志里 `v` 一直是 `0.1.0`。

对策（本项目已内置）：

- `wbcs deploy` 检测到 `WorkBuddy.exe` 在跑就**拒绝部署**，提示先托盘退出；`--force` 才热更新
- 部署改成**就地覆盖 + 只清理旧分片**，不再 `rm -rf` 整个扩展目录（避免瞬间缺文件）
- `extension.json` 支持 `ui.onLoadError.errorMessage`（内置的 library 扩展就这么用），把兜底文案换成可操作的提示
- 页面启动时用 URL 上的 `v` 跟自己的 `PAGE_VERSION` 对比，不一致就顶部弹一条黄条：「重启即可，不是网络问题」

宿主负责渲染兜底文案的组件不在本地包里（本地 `app.asar` 与 `renderer/assets` 都搜不到这句中文），说明这套 UI 有远程下发的部分，所以别指望在本地改文案。

---

### 6.4 面板内拉正文：两条通道，以及它们的边界

v1.1.0 起，「同步」之后会顺手把新会话的正文也拉下来。顺序是：

**① 客户端会话服务（首选）**

```js
window.__wbInvoke('wb:conversations:get', args)   // 扩展 preload 直接暴露，不用走 MessagePort
```

- `preload/extension-window.js` 里有 `contextBridge.exposeInMainWorld('__wbInvoke', ...)`，
  它 `ipcRenderer.invoke('wb:invoke', channel, payload)`，比 6.0 的 MessagePort 少一层 boundary。
  所以扩展 iframe 的通道能力实际上是**两套**：老 postMessage（已废）、MessagePort（guest-ready 那一套）、`__wbInvoke`（最直接）。
- `wb:conversations:get` 是 daemon RPC。内置扩展 `edge-sync` 的 service 侧就是拿它读会话的
  （`wb:conversations:list` / `:get` / `:sendPrompt` …），说明这些通道对扩展侧是开放的。
- **入参形态没有文档**。面板按 `[id]` → `{conversationId}` → `{id}` → 裸 `id` 依次试，谁先回可解析结构就用谁，
  每次尝试的返回形状都会打进「数据与诊断」（`conv/get :: v0 {"info","requests"}`）。
- 返回里 `info.transport === 'local'` 才有正文；云端会话可能需要客户端先打开过那条会话。

**② 云端 ACP 直连（兜底，成功率低）**

```
wb:http:get  /console/as/conversations/<id>/session     → link + token（宿主带 cookie，成功）
fetch(link)  accept: text/event-stream                  → 需要 CORS
POST         initialize / session/load                  → 需要预检放行自定义头
```

实测网关（APISIX 前置）对 `wb-extension://...` 这个 origin **不返回**
`access-control-allow-origin`，而且 `Acp-Connection-Id` 不在 `access-control-expose-headers` 里，
浏览器里连读响应头都不行 → 这条路基本会被 CORS 挡死。代码保留着，通了就是白捡。

**③ 真正干净的做法：给扩展加 Node service（尚未启用）**

`extension.json` 支持 `"service": { "entry": "./server/index.cjs", "process": "fork" }`
（内置扩展 `edge-sync` 就是这么写的），宿主会 fork 一个 Node 进程，
入口导出 `activate(wb, ctx)` 并返回 `{ methods, dispose }`；UI 侧用
`wb.extensions.invoke(<extensionId>, <method>, payload)` 调（对应私有通道
`wb:internal:extension-service-invoke`，自带 accountGeneration / instanceGeneration 校验）。

service 里既有 `https`（SSE 无 CORS 限制），也能 `wb.invoke('wb:http:get', url)` 复用宿主 cookie，
等于把 `src/acp.js` 那套完整搬进客户端。代价是 manifest 要声明 service、宿主要能 fork 成功，
属于下一版的事。

---

## 7. 已知限制

- 正文默认是**抓取时的快照**；新增会话由面板就地拉取（6.4 的两条通道），两条都不通时才需要 `wbcs fetch` 增量补
- 单条会话回放靠空闲超时收尾，超大会话（>5000 事件）可能被截断，可调 `--idle` / `--max`
- 定时任务类会话通常只有任务定义、没有对话记录，属于数据本身如此
- Windows / macOS / Linux 的扩展目录都做了探测，但只在 Windows 上实测过

---

## 8. 时间线（怎么一步步摸出来的）

1. 确认 DB 有 88 条 cloud 会话、正文缺失 → 排除"数据没同步"
2. 在 `app.asar` 里定位 `DesktopCloudTaskEntry`，确认入口被写死关闭
3. 猜 `/api/session/messages` → 404，排除 REST
4. 有头浏览器抓网页版真实流量 → 发现 `/acp` 的 JSON-RPC 和 SSE
5. 缺 `acp-connection-id` → 404；改成从 SSE 响应头取 → 通
6. 补齐时序（先 initialize、再 session/load、等 SSE ready）→ 历史正常回放
7. 解析 `session/update`，丢弃 artifact 噪音 → 4283 条消息落地
8. 打包成扩展，走 bundled 目录免签名挂进侧栏
