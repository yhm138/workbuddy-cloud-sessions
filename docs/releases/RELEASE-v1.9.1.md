# v1.9.1 — 修「拉取失败：缺少 id」

v1.9.0 的云端直连在这台机器上报 `缺少 id`，但同一条会话在网页版能打开、复制 ID 也正常。
原因不是网络、不是票据，是**参数顺序**。

## 出了什么问题

宿主调用扩展 service 方法的链路是：

```
invokeExtension(method, ...args)
  → transport.invoke(method, { callerId }, ...args)
  → fork 侧 transport.handle(channel, (...args) => fn(...args))
  → fn(context, payload)
```

也就是说，进程里**第一个参数永远是 context**。而 v1.9.0 判「这是不是 context」用的是：

```js
v.callerId !== undefined
```

没有 caller 时，宿主传的是 `{ callerId: undefined }` —— 键在、值是 `undefined`，`!==` 判不出来。
于是 context 被当成了业务载荷，`payload.id` 自然为空。

最迷惑的是：同一时刻 `ping`、`status` 全部正常，诊断里显示 `service v1.9.0 · pid …`，
看起来通道完全通了。因为这两个方法不看参数。

## 改了什么

- **判据改成 key 存在性**：`"callerId" in v` / `"invocation" in v` 等，覆盖了宿主真实传的
  十来个 context 字段（`transport`、`endpoint`、`invocation`、`accountGeneration`…）
- **多参数提取**：`pickParams(...args)` 兼容 `(payload)` / `(payload, context)` /
  `(context, payload)` 三种形状，取「不像 context 的那个」
- **兜底捞 id**：万一形状又变了，从所有参数里深度找 15 位以上纯数字（会话 ID 就是 19 位）
- **错误自带现场**：`缺少 id · 参数 ({callerId=undefined}, {force=boolean:true})`，
  下次再遇到同类问题，一眼就能看出宿主传了什么；`status` 里也多了 `calls` 最近 12 次调用形状
- **假宿主改成真实形状**：`test/panel-service.js` 现在按 `fn({ callerId: undefined }, payload)`
  调用，`test/service-acp.js` 加了对应断言 —— 这个 bug 以后跑测试就会红

## 验证

```
✓ 宿主形状 (ctx, payload) 取到 id
✓ 缺 id 时带回参数形状
✓ status 缓存 1 条 · calls 8 条
✓ 面板：提示条「云端最新 · 2026-10-23 21:40 从云端回放（9 个事件）」
✓ 降级模式（NO_SERVICE=1）：正常退回落地卡，不白屏
```

## 装法

1. 托盘右键退出 WorkBuddy（只关窗口不算）
2. 解压后双击 `安装.bat`，跟着提示走
3. 打开客户端 →「云端会话」→ 随便点一条，正文顶部应该是「**云端最新** · hh:mm 从云端回放」

已经装过 1.9.0 的话，也可以只替换文件：解压覆盖到扩展目录，然后托盘退出重开
（service 是启动时 fork 的，热替换不生效）。
