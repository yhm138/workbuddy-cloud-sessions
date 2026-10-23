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

**④ 结论（2026-10-23 实测）：不是参数问题，是数据源问题**

查 `edge-sync/server/index.cjs` 的 `REMOTE_WB_METHOD_BINDINGS`：

```js
{ channel: "wb:conversations:requests",
  localConversationIdArg: 0,          // 第一个参数就是 conversationId
  activatesConversationStream: true,  // 调用会激活会话流
  projectResult: (v, _i, ctx) => projectRemoteRequestsPage(v, ctx) }
```

它**没有 `prepareArgs`**，`projectResult` 只是把 `items` 逐条投影（`projectRemoteRequest`），
原样透传其余字段。也就是说这个通道读的是**本机 daemon 的历史**，不是去云端现拉。

而 cloud 会话的消息根本不在本机：

- `~/.workbuddy/workbuddy.db` 只有 `sessions` 等 12 张表，**没有任何消息表**；
- 本机唯一有的，是客户端**上次自己打开该会话时**落下的片段；
- 客户端打开会话才走云端 ACP 回放全量 —— 这正是「回到会话」永远能看到最新内容的原因。

实测两条 cloud 会话：

| 会话 | 现象 | 真相 |
| --- | --- | --- |
| `2112531641764274176` | 索引 22 条，实际只渲染 8 轮，尾部缺失 | 快照是半截的 |
| `2113427660396220416` | 一条都读不到，`requests` 返回空 | 本机从未打开过它 |

所以「同步很慢还拉不到」不是超时或并发问题，**是这条路径对 cloud 会话本来就不存在**。
v1.4.0 起把面板定位改成**索引层**：

- 列表行尾常驻「↗」，一步 `workbuddy://chat/<id>` 回原会话（不再先进详情）；
- 正文拿不到时不再提供「重试阅读器」，改成一键「回到会话」的落地卡；
- 正文有快照时顶部挂一条「本机快照 · 可能不是最新」的说明，不让人误以为看到了全部；
- 后台补快照收敛到最近 30 条、并发 2、失败静默（原来全量 4 并发会空转几十秒）。

---

## 6.5 打开 `DesktopCloudTaskEntry`：把云端会话放回原生侧栏

这条比扩展本身更根本 —— 客户端的侧栏本来就能显示云端会话，只是被一个打包期写死的开关挡住了。

### 三处硬编码

在 `app.asar` 里搜 `DesktopCloudTaskEntry`，只有 5 处命中，其中 3 处是"关"：

| 位置 | 代码 | 作用 |
| --- | --- | --- |
| `renderer/assets/artifact-slot-panel-*.js` | `createProductFeatureHook({featureKey:'DesktopCloudTaskEntry',resolve:()=>!1})` | 侧栏/搜索读的总开关 |
| `main/server.js` | `desktopCloudTaskEntryEnabled=()=>!1` | 全局搜索 `CloudTaskSearcher` + 会话元数据快照 |
| `renderer/assets/contexts-*.js` | `desktopCloudTaskEntryEnabled:m=!1` | 侧栏分组参数的默认值 |

`resolve` 是 `() => !1`，**不接受任何入参** —— 所以改账号配置、改 `product.json`、等服务端灰度都没用，
它压根不读配置。只能改字面量。

真正拦人的是 `shouldAddConversationOptimistically()`：

```js
function shouldAddConversationOptimistically(e, t) {
  return !(t.isLocalDesktop && !t.desktopCloudTaskEntryEnabled && e.transport === 'cloud'
        || isOtherClientCloudLocalOriginMirror(e) || hasQuickAskConversationTag(e.tags))
}
```

桌面端 + 开关关 + `transport === 'cloud'` → 云端会话不进侧栏。本地 SQLite 的 `sessions` 表里
其实一直有这些记录（`where transport='cloud'`），列表数据是现成的，纯展示层被挡住。

### 怎么改

`!1` → `!0`，三者等长，直接原地覆盖字节：

```bash
python tools/patch-cloud-task-entry.py --check     # 看现状
python tools/patch-cloud-task-entry.py --apply     # 打补丁
python tools/patch-cloud-task-entry.py --restore   # 用 app.asar.wbbak 还原
```

前提与边界：

- `WorkBuddy.exe` 里查不到 `EnableEmbeddedAsarIntegrityValidation`，即**没有 asar 完整性校验**，
  改字节不会被判定篡改（`OnlyLoadAppFromAsar` 只是限制加载来源，不影响内容）。
- 替换前后文件长度一致，asar header 里的 offset/size 全部有效，不用重新打包。
- 验证方式：和 `app.asar.wbbak` 逐字节比对，应当**只有 3 个字节不同**。
- 客户端必须「托盘 → 退出」重启，renderer bundle 才会重新加载。
- 客户端升级会整包替换 `app.asar`，补丁失效，需要重打。

### 实测结果：三处全开会启动闪退（已还原）

02:30 打补丁后，客户端重启直接闪退，用 `restore-client-patch.bat` 还原才恢复。
三个字节都合法（等长替换、asar header 无损），所以不是包损坏，是**打开了未走通的代码路径**：

- 侧栏一旦认云端会话，`shouldAddConversationOptimistically` 放行 → 走云端的
  `readVisibleCloudConversationMetas`、云端分组渲染、`CloudTaskSearcher` 搜索；
- 这些路径在打包时被裁掉/未联调，运行时缺少依赖（很可能缺 daemon 侧的云端会话列表接口），
  renderer 直接抛错 → 白屏/闪退；
- `main/server.js` 那处改的是主进程侧，崩了更难恢复。

**结论：这条路依赖客户端未发布的能力，不具备可维护性**，不建议继续折腾。
只改 renderer 两处、不改 `main/server.js` 是否更稳，尚未验证；即便成立，升级即失效。

### 打开之后是什么样

- 侧栏出现「云端任务 / Cloud Tasks」分组（i18n key `conversation.cloudTasks` 早就在包里）
- 点进去就是原生会话页 —— 和「回到会话」完全同一套界面、同一套 ACP 通道
- 全局搜索里多出 `cloud-task` 这个 searcher（`CloudTaskSearcher`）

也就是说：**真正的融合不是把网页塞进 iframe，而是让原生 UI 认这些会话**。
扩展的定位随之变成补充：全量快照、离线浏览、Markdown 导出、跨来源统计分析。

---

## 6.6 快照提醒弹窗的关闭约定

进详情若有快照，弹一次模态提醒（`sessionStorage` 键 `wbcs.snap.<id>` 去重，重开面板才会再弹）。

**只有显式动作用户才能关：**

| 关闭方式 | 说明 |
| --- | --- |
| 右上角 ✕ | 主路径，26px 热区，SVG 图标 |
| 「先看快照」 | 明确表示已知情，进入只读快照 |
| Esc | 键盘快捷键，第二次 Esc 才返回列表 |

**点卡片以外的遮罩不关闭** —— 这是刻意设计：这条正文可能是残缺的，提醒必须被看见一次，
不能靠点空白处误关。实现上不再给 `.modal` 绑 click，`onclick`/`onpointerdown` 显式置空，
避免以后有人加回「点外面关闭」。

v1.5.0 曾用 `ev.target === m` 判遮罩，在窄面板下卡片几乎占满、可点区域只剩 18px，
既容易误点也容易点不到；现在干脆去掉这条路。

## 6.7 安装包：让「双击就能用」成立的三件事

发布版是 `*-win-x64.zip`，解压双击 `install.bat`。三个决定都是被现实逼出来的：

**① 自带 `node.exe`**
「装 Node、配 PATH、npm install」这三步对目标用户等于劝退。打包时把官方
`node-v22-*-win-x64.zip` 里的 `node.exe` 抠出来放进 `runtime/`（83 MB，压完 ~30 MB），
`install.bat` 直接用它跑 `app/bin/wbcs.js install`。同时它也满足 `node:sqlite` 的版本要求。

**② 不带 Chromium，复用系统浏览器**
Playwright 的浏览器要额外 150 MB，而且版本号必须和 `playwright-core/browsers.json` 对齐
（客户端自己装的 `chromium-1223` 就和 npm 版期望的 `1248` 对不上）。写成兜底链之后
（`src/browser.js`）：

```
上次成功的浏览器 → channel: chrome → channel: msedge → 扫描 ms-playwright 里的 chrome.exe → 自带
```

Windows 一定自带 Edge，所以「一次都没下载过浏览器」的机器也能登录。

**③ 把浏览器选择钉死**
Edge 与 Chrome 往同一个 profile 目录写 cookie 的加密密钥不同（Chrome 127+ 还有
app-bound 加密，密钥跟可执行文件绑定）。这次用 Chrome 扫码、下次用 Edge 读，cookie 读出来
就是空的，表现为「明明登录过又跳扫码页」。所以第一次成功启动后把
`{key,label,exe}` 写进 `<WBCS_HOME>/browser.json`，之后永远优先它。

另外两条工程约定：

- 安装包**绝不能**包含 `ui/data.js`、`ui/full/`（那是真实会话）。`tools/build-release.js`
  发现它们存在会直接报错退出，而不是默默排除。
- `zip` 打包用 `-UN=UTF8`，否则中文文件名（`安装.bat`、`使用说明.txt`）到 Windows 资源管理器
  里会变成乱码；同时额外放一个 ASCII 名的 `install.bat`，任何解压工具都能走通。

## 6.8 自动同步，以及「能不能靠打开会话补最新」

**自动同步（v1.8.0）**：宿主是 `keepAlive` 的，iframe 不会重新加载，所以「又点进来了」不能靠
onload 判断。用三个信号，汇到同一个 60 秒节流的 `autoSync()`：

| 信号 | 说明 |
| --- | --- |
| boot 后 1.2s | 首次进入，等桥接就绪 |
| `IntersectionObserver` on `#main` | 面板被隐藏再显示（0 → 可见） |
| `visibilitychange` / `window.focus` | 窗口切走再回来 |

自动模式下失败**不弹 toast**（只写诊断，并把节流额度退回去，等下次可见再试），
成功但没有新会话也**不提示**——否则每次点进来都弹一下，很吵。

**「用会话打开的方式把最新快照拉到本地」为什么走不通**（三条独立证据）：

1. **落盘的本就不是完整历史。** 客户端打开会话时走 ACP 回放，但 daemon 只留下请求片段：
   实测某会话索引 22 条、面板只渲染 8 轮，且尾部缺失。
2. **cloud 会话在客户端里显式跳过 runtime。** 主进程里 `ensureRuntime()` 第一行就是
   `if (this.init.transport === 'cloud') return;` —— 云端会话根本不建本地 runtime/缓存，
   所以「打开过 = 有本地副本」这个前提对 cloud 不成立。
3. **深链能触发全量回放，但不是同步手段。** 它会把窗口切到那条会话，一条一次；
   89 条要点 89 次，用户没法干别的。

**唯一干净的路：给扩展加 service**（6.4 ③）。宿主通道里确实有 `wb:http:post`（不只是 get），
但 ACP 的历史是从 **SSE 长连接**里回放的，`wb:http:*` 是请求/响应，拿不到流；所以必须有一个
真正的 Node 进程：用 `https` 建 SSE，用 `wb.invoke('wb:http:get', ...)` 借宿主 cookie 换
`{link, token}`（等于把 `src/acp.js` 原样搬进客户端）。那样连扫码登录都不需要了。

门槛写在 edge-sync 的清单里，很明确：

```json
// extension.json
"service": { "entry": "./server/index.cjs", "process": "fork" }
// distribution.json
"processPolicy": { "server": "fork", "renderer": "iframe" }
```

代价是必须重启客户端才能验证 fork 是否成功。**v1.9.0 已经做了，见 6.9。**

## 6.9 扩展内 service：让面板直接回放云端（v1.9.0）

### 为什么非得是 service

- iframe 里 `fetch()` 打 ACP 网关会被 CORS 拦死：网关既不回 `access-control-allow-origin`，
  也不 expose `acp-connection-id`，连 `initialize` 都发不出去
- `wb:http:*` 是请求/响应，而历史是从 **SSE 长连接**里回放的，拿不到流
- 所以只能有一个真 Node 进程：`https` 建 SSE 不受 CORS 管，`wb.http.get` 借宿主 cookie 换票据

### 清单

```json
// extension.json
"service": { "entry": "./server/index.cjs", "process": "fork" }
// distribution.json
"processPolicy": { "server": "fork", "renderer": "iframe" }
```

### 服务端契约

- 宿主 fork 子进程（注入 `main/preload/fork-preload.cjs`），然后调模块导出的 `activate(wb)`
- `activate` 返回 `{ methods, dispose }`；`methods` 是 `name -> async (context, payload) => result`
  —— **context 在前**，这个顺序坑过一次，见下面踩坑第 6 条
- 方法名有约束：不能含 `/`、不能以 `wb:internal:` 开头、长度 ≤ 128
  （`isExtensionLocalRpcMethodName` / `assertPublicExtensionMethod`）；宿主内部按
  `` `${extensionId}/${method}` `` 存白名单
- 返回值必须能被**结构化克隆**：只放数组 / 字符串 / 数字，别塞函数、Map、Buffer
- `wb.http.get(url, { headers })` 会带宿主自己的 cookie 和 bearer，返回体常被 `{code,msg,data}`
  包一层，得先拆

### 面板侧：两跳

```js
// ① 换票据（幂等，多要一张也无所谓）
wb:extensions:$resolveLocalRpc(extensionId, method)
// → { extensionId, protocolVersion: 2, serviceInstanceId, runtimeGeneration, methods[],
//     ticket, fallbackToken, fallbackExpiresAt }

// ② 调用
wb:extensions:$invokeLocalRpcFallback(extensionId, method, payload, fallbackToken)
```

`fallbackToken` 是 UUID，**有效期 5 分钟**。宿主的实际分发代码（`app.asar` 里那个
`ae = new Map([[Ga,…],[Ka,…],[qa,…]])`）：

```js
[qa, async (ctx, extId, method, payload, token) => {
  if (typeof extId !== "string" || typeof method !== "string" || typeof token !== "string")
    throw Object.assign(Error("…"), { code: "INVALID_ARGUMENT" });
  const access = resolveLocalRpcAccess(ctx?.subject, extId);   // ← 由宿主推断，伪造不了
  if (!access) throw Object.assign(Error("…"), { code: "PERMISSION_DENIED" });
  return registry.invokeLocalRpcFallback(extId, method, payload, access, token);
}]
```

所以 `fallbackToken` 只证明「这张票是发给这个 iframe 的」，真正的授权靠
`ctx.subject`（self-guest 必须挂在这个扩展的 iframe 上）。

失败码：`PERMISSION_DENIED`（票不对/调用方不匹配）、`EXTENSION_CONTEXT_STALE`
（service 被回收后重建，`runtimeGeneration` 变了）、`EXTENSION_LOCAL_RPC_BUSY`、
`INVALID_ARGUMENT`。面板要能自愈：清票 → 重新 resolve → 再调用一次。

### 通道怎么走

两条都能到，先探测再钉住（`localStorage` 的 `wbcs.sbStyle`）：

- MessagePort：`Bridge.invoke(channel, args, timeout)`，就是 guest-ready 握手那条
- IPC：`window.__wbInvoke(channel, null, ...args)`（第二个参数会被宿主当 subject 剥掉）

### 踩过的坑

1. 网关回的 `link` 常是 `http://`，但 ACP 只认 `https`；**只升级 `*.workbuddy.cn`**，
   别把本地假网关（`http://127.0.0.1`）也改掉，否则自测跑不起来
2. 并发别贪：网关对并发敏感，2 条是实测稳的值，3 条以上容易 `no_token_401` 或连接被掐
3. 单条回放：空闲 4s 收尾、硬超时 60s；一次最多回 6000 条消息（IPC 塞太大会断）
4. 缓存 24 条、TTL 3 分钟，够覆盖「来回点几条」又不至于吃内存
5. 服务被 idle evict 是常态，不是错误 —— 票据过期 + 上下文失效两条路都要能恢复
6. **参数顺序：`fn(context, payload)`，而且 context 里的 `callerId` 可能是 `undefined`。**
   链路是 `invokeExtension(method, ...args)` → `transport.invoke(method, { callerId }, ...args)`
   → fork 侧 `transport.handle(channel, (...args) => fn(...args))`，所以进程里第一个参数
   永远是 context。判「像不像 context」**只能**用 `"callerId" in v` / `"invocation" in v`，
   不能用 `v.callerId !== undefined` —— 没有 caller 时它是 `undefined`，`!==` 判不出来，
   于是 context 被当成业务载荷，`payload.id` 为空，面板收到「缺少 id」，但同一时刻
   `ping` / `status` 一切正常（它们不看参数），非常容易误判成「通道没通」。
   v1.9.0 线上就是这个；v1.9.1 改成「按 key 存在性判 context + 从所有参数里兜底捞 19 位
   会话 id + 错误信息带上参数形状」

### 没有客户端时怎么验证

```bash
node test/service-acp.js     # 假网关 + 直接调 activate，覆盖票据/回放/缓存/失败分支
node test/panel-service.js   # Playwright 起假宿主（test/host.html），把两条通道接到同一份
                             # service 上，断言面板真从「云端」拿到正文
NO_SERVICE=1 node test/panel-service.js   # 降级路径：必须退回快照模式，不许白屏
```

假宿主要照抄宿主的三条约定：`$resolveLocalRpc` 返回 `fallbackToken/fallbackExpiresAt`，
`$invokeLocalRpcFallback` 收 `(extId, method, payload, token)` 四个参数、就是这个顺序；
真正调 service 方法时也要按宿主的形状来 —— `fn({ callerId: undefined }, payload)`，
**不要**偷懒写成 `fn(payload)`，否则测试永远抓不到第 6 条那个坑。
顺序错了不会告诉你「参数错了」，只会先撞 `INVALID_ARGUMENT`（第 4 个参数本该是票据字符串，
结果收到的是 payload 对象），或者一路 `PERMISSION_DENIED`。所以假宿主里要显式 `assert`
一下 token 的形状，让错误尽早暴露在测试里。

## 6.10 v1.10：把「等」砍掉，把「点了就丢」堵住

v1.9.1 能拉到正文了，但两个体验问题很明显：**等得久**、**底部输入条回车后文字没了**。
这一节记下两件事的真实原因和改法。

### 6.10.1 那 5 秒到底花在哪

一次冷启动回放的耗时链（v1.9）：

| 阶段 | 典型耗时 | 原因 |
| --- | --- | --- |
| 换票据 `wb.http.get` | 150~400ms | 宿主主进程发请求，省不掉 |
| SSE 建连 | 150~600ms | 每次新建 TCP+TLS，没有 keep-alive |
| `sleep(600)` | **600ms** | 死等「握手帧落地」 |
| `initialize` | 80~250ms | 一次 JSON-RPC |
| `sleep(300)` | **300ms** | 死等第二次握手 |
| `session/load` + 回放 | 200~1500ms | 真正的内容 |
| **空闲收尾** | **4000ms** | 历史没有结束标记，写死 4s 静默判定 |

也就是说：**真正的内容 1 秒内就到了，剩下 4.9 秒全在等规则**。v1.10 的做法是：

1. `idle` 从 4000 收到 **1400**；`session/load` 拿到回执后进一步收到 **700**
   （尾部只剩残留帧，来一帧就顺延，不会截断）
2. 首帧到达即发 `initialize`（不再 `sleep(600)`），`initialize` 返回即发 `session/load`（不再 `sleep(300)`）
3. 两条 `https` 走同一个 **keep-alive Agent**，同一会话的 3 个请求复用一条连接
4. **`peek` 方法 + 面板轮询**：边回放边把已经解析出的消息画出来（280ms 一次，条数没涨就不重绘），
   第一段正文通常在 0.6~1s 内出现，尾部继续补
5. **`ts` 缓存**：列表里 `updatedAt` 没变就直接复用（30 分钟内），来回点不再重放
6. **hover 预取**：鼠标停在某行 150ms 就先去拉，点进去时多半已在缓存里
7. 进面板 `warm()` 预热 TLS 连接

实测（假网关，纯本地）：**4200ms → 830ms**；真机上票据和回放的网络耗时省不掉，
但 4.9 秒的「规则等待」只剩 2.1 秒左右，且首屏 1 秒内就有内容。

`status()` / 诊断面板里现在会带 `last.timings`（票据 / 握手 / 首帧 / 回放），
真机上调参看这一行就行。

### 6.10.2 底部输入条：为什么「回车后输入框是空的」

v1.9 的链路是：

```js
openSessionInClient(id);        // 深链，面板被切走
setTimeout(() => fillMessage(text), 800);   // 再调 wb:message:fill
```

第 6.2 节已经写过 `wb:message:fill` 的真实语义 —— 它把内容推进**主窗口 composer 的事件流**，
并且会顺手把 `currentConversationId` 置空（等于切到一个新草稿）。于是：

- 深链刚把窗口切到目标会话，`fill` 又把用户切回「新草稿」
- 切换过程中 composer 可能还没挂载，事件**没人接，静默丢弃**
- 用户看到的就是：跳到会话 → 输入框空的 → 刚才写的话像被吞了

这条路没法靠「等久一点再 fill」修好，因为目标本身就是错的。v1.10 改成**两步、且一步都不丢**：

```
① 回车 → 这句话写进 localStorage 草稿 + 进剪贴板 + 底部弹出确认条
② 再回车 / 点确认条按钮 → 才真的打开会话，并提示「Ctrl+V 粘一下」
```

顺序是「先复制、后跳转」，所以即使面板被销毁、宿主吞事件，剪贴板里也一定有一份。
草稿按会话 id 存（`wbcs.drafts`），回列表再点回来还在。

### 6.10.3 小程序 / App 来源的会话：深链过去是空的

`2070359399505326080` 这类 `conversationOrigin=workbuddy-mp` 的会话，
本地库里有一条记录（所以侧栏能看到，`transport=cloud`），但客户端打开时是
**「暂无对话记录」** —— 客户端只认自己产生的对话记录，手机端 / 小程序推上来的历史它不加载。

对照证据：同一个 id 用 `https://www.workbuddy.cn/app/conversation/<id>` 是完整的，
我们的 service 也能通过 ACP 回放出来，只有客户端的会话页是空壳。

v1.10 的处理是**不给深链挖坑**：

- 详情页主按钮在小程序/App 来源下变成「网页版打开」，菜单里另留「回客户端（可能为空）」
- 列表行上的 ↗、以及任何走 `openSessionInClient` 的入口，遇到这两类来源先弹选择框，
  说明「客户端里为什么是空的」，默认动作指向网页版

判断依据只有 origin 一个信号（`workbuddy-mp` / `workbuddy-app`），因为它对应的是
「历史只存在于云端、客户端没跑过这条会话」这个事实。

## 7. 已知限制

- **service 不可用时，面板退回快照**（6.4 ④、6.9）：正文顶部会标「本机快照 · 可能不是最新」。
  这时「最新」只能靠 `workbuddy://chat/<id>` 回客户端看
- 云端直连是「点开才拉」：列表里的条数来自快照与本机索引，**不代表云端最新**
- 单条会话回放靠空闲超时收尾（v1.10 收到 1.4s / 回执后 0.7s），超大会话
  （>5000 事件）理论上仍可能被尾部截断；真遇到可以给 `fetchBody` 传 `idleMs` 调大
- **小程序 / App 来源（`workbuddy-mp` / `workbuddy-app`）的会话，客户端打开是「暂无对话记录」**
  —— 历史只在云端，客户端不加载。这类一律引导到网页版（6.10.3）
- 定时任务类会话通常只有任务定义、没有对话记录，属于数据本身如此
- Windows / macOS / Linux 的扩展目录都做了探测，但只在 Windows 上实测过
- **`service` 这条链路只在本地假宿主里验证过**；真客户端 fork 是否成功、`wb.http.get`
  是否真带 cookie，需要重启客户端后看「数据与诊断」的「云端直连」一行

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
