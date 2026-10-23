# 逆向笔记：一个写死的 `false`

> 这篇讲「怎么摸出来的」，不追求可复现的完整性 —— 所有结论都来自对 WorkBuddy 桌面端（Electron / Windows，2026-10 版本）的静态分析和真实抓包。
> 具体字段与接口约定见 [PROTOCOL.md](PROTOCOL.md)，系统设计见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 0. 起点：88 条会话，0 条正文

问题是这么冒出来的：我在手机和网页版上聊过的对话，回到桌面客户端就找不到了。侧栏里干干净净，搜索也搜不出。

先去翻本地库 `~/.workbuddy/workbuddy.db`：

```sql
select transport, count(*) from sessions group by transport;
-- local   | 213
-- cloud   |  88
```

**88 条云端会话，记录都在，标题都在。** 那问题不在同步，在展示。

再查正文：

```sql
select count(*) from messages;      -- 只覆盖 local 会话
```

云端会话一条消息都没有。也就是说——**正文从来没落过盘，它只存在于云端**。

这就把问题定死了：不是「数据没同步过来」，而是「入口被挡住了，而且本地根本没有副本」。

---

## 1. 找到那个开关

在 `app.asar` 里搜 `cloud`，很快就会撞上 `DesktopCloudTaskEntry`。整个包里只有 5 处命中，其中 3 处是「关」：

| 位置 | 代码 | 作用 |
| --- | --- | --- |
| `renderer/assets/artifact-slot-panel-*.js` | `createProductFeatureHook({featureKey:'DesktopCloudTaskEntry',resolve:()=>!1})` | 侧栏 / 搜索读的总开关 |
| `main/server.js` | `desktopCloudTaskEntryEnabled=()=>!1` | 全局搜索 `CloudTaskSearcher` + 元数据快照 |
| `renderer/assets/contexts-*.js` | `desktopCloudTaskEntryEnabled:m=!1` | 侧栏分组参数默认值 |

关键在这行：`resolve` 是 **`() => !1`，不接受任何入参**。

它压根不读配置——所以改账号设置、改 `product.json`、等服务端灰度，全都没用。这是编译期常量，只能改字面量。

再往下追，真正拦人的是 `shouldAddConversationOptimistically()`：

```js
function shouldAddConversationOptimistically(e, t) {
  return !(t.isLocalDesktop && !t.desktopCloudTaskEntryEnabled && e.transport === 'cloud'
        || isOtherClientCloudLocalOriginMirror(e) || hasQuickAskConversationTag(e.tags))
}
```

桌面端 + 开关关 + `transport === 'cloud'` → 云端会话不进列表。**数据都在，纯展示层被挡住。**

---

## 2. 正文在哪：猜 REST 是错的

第一反应当然是找 REST 接口。翻 asar 找到 `batch-get`、`/console/as/conversations/...`，拼了几个 `/messages` 之类的路径——全部 404。

于是换了个笨办法：**用有头浏览器登网页版，打开一条云端会话，看它到底请求了什么。**

结果很意外：正文根本不走 REST，走的是 **ACP（Agent Client Protocol）over HTTP + SSE**——就是 CLI 里那套 JSON-RPC 风格的长连接。

三步：

1. `GET /console/as/conversations/{id}/session` → 拿到消息服务地址 `link` + 沙箱 JWT
2. `GET {link}`，`accept: text/event-stream` → **响应头里下发 `acp-connection-id`**
3. `POST {link}` 发 `initialize`，再发 `session/load`，历史以 `session/update` 事件流回放

---

## 3. 三个坑，一个比一个安静

**坑一：`404 connection not found`。**
POST 不带 `acp-connection-id` 必 404。而这个 id 不在任何 REST 响应里，只在 SSE 的**响应头**里。

**坑二：SSE 没 ready 就 POST，同样 404。**
`GET` 返回 200 不代表连接可用。得等第一个字节落地，再发 `initialize`。

**坑三：`initialize` 和 `session/load` 的顺序不是可选的。**
先 `initialize` 协商协议版本，再 `session/load` 带 `sessionId`；少了前者，后者静默不回放。

把这三件事按顺序做对，历史就开始一条条吐出来了。

---

## 4. 事件流里 95% 是噪音

`session/update` 有六七种 `sessionUpdate` 类型：

| 类型 | 处理 |
| --- | --- |
| `user_message_chunk` | 按 `messageId` 合并成一条 |
| `agent_message_chunk` | 同上 |
| `agent_thought_chunk` | 单独成条（可折叠） |
| `tool_call` / `tool_call_update` | 按 `toolCallId` 配对，收成一行 |
| `session_info_update` | 提取标题 |
| `_codebuddy.ai/artifact` | **丢弃** |

最后那个是重灾区：单条会话能有一万多条 artifact 快照，全是中间产物。第一版没过滤，解析一条会话要十几秒、内存飙到几百 MB。丢掉之后，4283 条消息落地只花了两秒。

---

## 5. 挂进侧栏：为什么没去改 asar

路有两条：

**A. 改 `app.asar` 里的三个 `!1` → `!0`。**
三个字节等长替换，asar header 里的 offset/size 全都有效，客户端也没有 asar 完整性校验。看起来完美。

**B. 写个内置扩展，丢进 `app.asar.unpacked/resources/extensions/`。**
bundled 目录免签名，客户端启动时直接扫。

我先试了 A。**结果客户端启动直接闪退。**

三个字节都合法（`restore-client-patch.bat` 逐字节比对，只有 3 个字节不同），所以不是包损坏——是**打开了没走通的代码路径**：侧栏一旦认云端会话，就会走 `readVisibleCloudConversationMetas`、云端分组渲染、`CloudTaskSearcher`，而这些路径在打包时被裁掉或没联调，运行时缺依赖，renderer 直接抛错。

> 结论：这条路依赖客户端未发布的能力，升级即失效，不具备可维护性。已还原，不建议折腾。
> 详情仍保留在 [PROTOCOL.md 6.5](PROTOCOL.md)。

于是走 B。扩展挂载的三个事实：

- 扫 `resources/extensions/` 与 `app.asar.unpacked/resources/extensions/`，后者免签名
- `extension.json` 里声明 `"ui": {"entry": "./ui/index.html", "mode": "iframe"}`
- 页面必须在 10 秒内完成 `guest-ready` 握手，否则界面显示「插件加载失败」——这条最坑，见 PROTOCOL 6.0

---

## 6. 最后一块拼图：不用扫码也能拿最新

到这里，面板能读的是**快照**——也就是上次 `wbcs fetch` 抓下来的那份。想要「点开就是最新」，还得现场回放。

问题还是 CORS：面板是 iframe，网关不回 `access-control-allow-origin`，也不 expose `acp-connection-id`，`fetch` 一律被拦死。

**转机是发现宿主给扩展开了 `wb.http.*`**，而且这个通道**自带宿主的登录 cookie**。但它只能请求/响应，拿不到 SSE 流。

那就只剩一条路：让扩展自己 fork 一个**真 Node 进程**。

```json
{ "service": { "entry": "./server/index.cjs", "process": "fork" } }
```

宿主 fork 它、调 `activate(wb)`；`wb.http.get` 换票据（**cookie 是宿主自己的，不用扫码**），真 Node 建 SSE 没有 CORS，POST 带上 `acp-connection-id` 就能回放。面板再用 `$resolveLocalRpc` + `$invokeLocalRpcFallback` 两跳把结果取回来。

这就是 v1.9 的「云端直连」。**扫码这件事，从头到尾都是可以绕开的**——只是得先意识到「宿主 cookie」比「浏览器 profile」更近。

---

## 7. 时间线

| # | 动作 | 结果 |
| --- | --- | --- |
| 1 | 数 DB | 88 条 cloud 会话，正文 0 条 → 排除「没同步」 |
| 2 | 搜 asar | 定位 `DesktopCloudTaskEntry`，确认编译期写死 |
| 3 | 猜 REST | `/messages` 之类全 404 |
| 4 | 有头浏览器抓包 | 发现 `/acp` 的 JSON-RPC + SSE |
| 5 | 缺 `acp-connection-id` | 404，改成从 SSE 响应头取 → 通 |
| 6 | 补时序 | 先 initialize 再 load，等 SSE ready → 历史正常回放 |
| 7 | 解析事件 | 丢掉 artifact 噪音，4283 条消息落地 |
| 8 | 打包扩展 | bundled 目录免签名挂进侧栏 |
| 9 | 改 asar 试原生入口 | 启动闪退 → 还原，放弃这条路 |
| 10 | 发现 `wb.http.*` 带 cookie | service 直连，去掉扫码（v1.9） |
| 11 | 发现「第一个参数是 context」 | 修 v1.9.0 的「找不到 id」（v1.9.1） |

---

## 8. 这次学到的（可复用的四条）

1. **`resolve: () => false` 这种签名说明它是编译期常量**，别浪费时间找配置项。搜到这种写法基本可以确定「改设置没用」。
2. **CORS 会决定架构**。一个 iframe 页面拿不到 `access-control-expose-headers`，就注定了要么有 Node 侧车、要么放弃实时。早点认清能省两天。
3. **「响应头里的握手 id」是最容易漏的一环**。SSE、WebSocket、GraphQL 订阅都有类似的连接标识，POST 前先把它拿到。
4. **热补丁二进制不如写扩展**。改 3 个字节看起来聪明，但崩溃时你会失去所有上下文；扩展崩了只是「插件加载失败」，还能调试。

---

**如果这些笔记帮你少挖了几天 `app.asar`，给项目点个 ⭐。**
