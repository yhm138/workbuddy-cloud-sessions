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

扩展 iframe 并非完全隔离，宿主暴露了一套 postMessage RPC：

```js
// 握手
{ type: 'wb:handshake:request', requestId, protocolVersion: '1.0' }
→ { type: 'wb:handshake:response', requestId }

// 调用
{ type: 'wb:invoke:request', requestId, channel: 'wb:http:get', args: [url, options] }
→ { type: 'wb:invoke:response', requestId, result }
            或 { ... , error: { code: 'PERMISSION_DENIED' } }
```

宿主侧 `assertAuthorized` 会校验 subject（来自扩展清单的 `grantedPermissions`）。

验证可用、且本项目实际用到的通道：

| 通道 | 用途 | 备注 |
| --- | --- | --- |
| `wb:config:get` | 读主题（`theme`） | 让页面跟随客户端深浅色 |
| `wb:shell:openExternal` | 用系统浏览器打开链接 | 沙箱里 `window.open` 常被拦，这是可靠出口 |
| `wb:message:fill` | 把内容填进客户端输入框（不发送） | 「接着聊」用它，参数 `[{ content: ContentBlock[] }]` |

`wb:http:get` / `wb:http:post` 在权限表里是 `http.get` / `http.post`，`grantedPermissions: ["*"]` 时有希望放行，但**没有 SSE 流式能力**，所以拿不到正文回放，只能用于普通 REST。

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

### 6.2 `wb:message:fill` 的参数

```js
Bridge.invoke('wb:message:fill', [{
  content: [{ type: 'text', text: '...' }]   // 或直接传字符串
  // mode / scene 可选
}])
```

语义是**填入输入框，不自动发送**（对应 `wb:message:send` 才会发）。这在桌面端才有意义：浏览器里没有宿主，调用必然失败，本项目会退回到"复制到剪贴板"。

---

## 7. 已知限制

- 正文只能是**抓取时的快照**，没有实时推送；新增会话需要重跑 `wbcs fetch`（增量）
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
