"use strict";

/**
 * server/index.cjs 的端到端自测（不联网、不要登录态）。
 *
 * 假网关 + 假宿主 wb，把「票据 → SSE 回放 → 解析 → 缓存/force → 失败分支」
 * 整条链路跑一遍。覆盖不到的只有「宿主真的 fork 了子进程」「宿主的 cookie
 * 真的能换到票据」这两步 —— 它们必须在客户端里验。
 *
 * 用法：node test/service-acp.js
 */

const assert = require("assert");
const { startGateway, makeWb, SESSION_ID } = require("./mock-gateway.cjs");
const { activate } = require("../server/index.cjs");

async function main() {
  const gw = await startGateway();
  const svc = activate(makeWb(gw.port()));

  const ping = await svc.methods.ping();
  assert.strictEqual(ping.ok, true);
  console.log("✓ ping", ping.version, "http=" + ping.http);

  const info = await svc.methods.inspect({ id: SESSION_ID });
  assert.strictEqual(info.ok, true, "inspect 应该拿到票据");
  assert.strictEqual(info.tokenLen, "fake-token".length);
  console.log("✓ inspect 拿到票据（token 长度 " + info.tokenLen + "）");

  const r1 = await svc.methods.fetchBody({ id: SESSION_ID, idleMs: 600, maxMs: 8000 });
  assert.strictEqual(r1.ok, true, "fetchBody 应该成功：" + JSON.stringify(r1));
  assert.strictEqual(r1.cached, false);
  const msgs = r1.shard.messages;
  assert.strictEqual(r1.shard.title, "假会话标题", "session_info_update 要更新标题");
  assert.strictEqual(msgs.length, 4, "user/thought/assistant 各合并成 1 条，加 1 条 tool");
  // 面板分片是数组格式：[role, text, kind, name, status, input, output]
  assert.strictEqual(msgs[0][0], "u");
  assert.strictEqual(msgs[0][1], "你好，在吗", "同一 messageId 的 chunk 要合并");
  assert.strictEqual(msgs[1][0], "h", "thought 必须映射成 h（不能和 tool 撞成 t）");
  assert.strictEqual(msgs[2][0], "a");
  assert.strictEqual(msgs[2][1], "在的，你说");
  assert.strictEqual(msgs[3][0], "t");
  assert.strictEqual(msgs[3][4], "completed", "tool_call_update 要落到同一条");
  assert.strictEqual(msgs[3][6], "ok");
  assert.strictEqual(r1.shard.stats.tool, 1);
  console.log(`✓ fetchBody → ${msgs.length} 条 · ${r1.shard.events} 事件 · ${r1.elapsed}ms`);

  const r2 = await svc.methods.fetchBody({ id: SESSION_ID });
  assert.strictEqual(r2.cached, "ttl", "第二次应该命中缓存");
  console.log("✓ 第二次命中缓存");

  /* 列表里的 updatedAt 没变时，缓存过了 TTL 也该直接复用（v1.10 的加速点）。
   * 假网关不认识 ts，所以这里用「同一 ts 命中」验语义：只要 ts 一致就返回 ttl 缓存。 */
  const r2b = await svc.methods.fetchBody({ id: SESSION_ID, ts: 123 });
  assert.ok(r2b.cached, "带 ts 的重复请求不该重新回放");
  console.log("✓ 重复请求走缓存（" + r2b.cached + "）");

  const r3 = await svc.methods.fetchBody({ id: SESSION_ID, force: true, idleMs: 600, maxMs: 8000 });
  assert.strictEqual(r3.cached, false, "force 应该绕过缓存");
  assert.ok(r3.shard.timings && r3.shard.timings.ticket >= 0, "结果里要带耗时拆解");
  console.log("✓ force 绕过缓存，重新回放（" + r3.elapsed + "ms）");

  /* v1.10：回放过程中要能 peek 到半成品，面板靠它边等边画。
   * 这里单独开一次 force 拉取，在途中读 peek。 */
  const watching = svc.methods.fetchBody({ id: SESSION_ID, force: true, idleMs: 900, maxMs: 8000 });
  await new Promise((r) => setTimeout(r, 250));
  const mid = svc.methods.peek({ id: SESSION_ID });
  assert.strictEqual(mid.ok, true);
  assert.strictEqual(mid.live, true, "回放中 peek 必须标 live");
  assert.ok(mid.n >= 1, "回放中至少能看到 1 条：" + JSON.stringify(mid).slice(0, 200));
  console.log("✓ peek 回放中 → " + mid.n + " 条 / " + mid.events + " 事件");
  const done = await watching;
  assert.strictEqual(done.ok, true, "watch 的这次拉取也要成功");
  const after = svc.methods.peek({ id: SESSION_ID });
  assert.strictEqual(after.live, false, "拉完必须清掉半成品，别让 peek 一直报 live");
  console.log("✓ 拉完清掉半成品");

  const bad = await svc.methods.fetchBody({ id: "nope", idleMs: 600, maxMs: 4000 });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, "NO_TICKET", "没有票据时要给出 NO_TICKET");
  console.log("✓ 无票据 → " + bad.code + "（" + bad.error + "）");

  /* 真实宿主的调用形状：transport.invoke(method, { callerId }, payload)
   * → 进程里是 fn(context, payload)。没有 caller 时 callerId 是 undefined，
   * 判据必须用 `in` 而不是 `!== undefined`，否则会把 context 当业务载荷，
   * 报「缺少 id」。（v1.9.0 的线上事故就是这个。） */
  const shaped = await svc.methods.fetchBody({ callerId: undefined }, { id: SESSION_ID, force: true, idleMs: 600, maxMs: 8000 });
  assert.strictEqual(shaped.ok, true, "宿主形状 (ctx, payload) 必须能取到 id：" + JSON.stringify(shaped));
  assert.strictEqual(shaped.shard.id, SESSION_ID);
  console.log("✓ 宿主形状 (ctx, payload) 取到 id");

  const noId = await svc.methods.fetchBody({ callerId: undefined }, { force: true });
  assert.strictEqual(noId.ok, false);
  assert.ok(/缺少 id/.test(noId.error) && /callerId/.test(noId.error), "没 id 时错误要带参数形状：" + noId.error);
  console.log("✓ 缺 id 时带回参数形状");

  const st = await svc.methods.status();
  assert.ok(st.cache.includes(SESSION_ID));
  assert.ok(Array.isArray(st.calls) && st.calls.length > 0, "status 要带最近调用形状");
  console.log("✓ status 缓存 " + st.cache.length + " 条 · calls " + st.calls.length + " 条");

  await svc.dispose();
  gw.server.close();
  console.log("\n全部通过");
}

main().catch((e) => {
  console.error("\n失败：", e && e.stack ? e.stack : e);
  process.exit(1);
});
