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
  assert.strictEqual(r2.cached, true, "第二次应该命中缓存");
  console.log("✓ 第二次命中缓存");

  const r3 = await svc.methods.fetchBody({ id: SESSION_ID, force: true, idleMs: 600, maxMs: 8000 });
  assert.strictEqual(r3.cached, false, "force 应该绕过缓存");
  console.log("✓ force 绕过缓存，重新回放");

  const bad = await svc.methods.fetchBody({ id: "nope", idleMs: 600, maxMs: 4000 });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, "NO_TICKET", "没有票据时要给出 NO_TICKET");
  console.log("✓ 无票据 → " + bad.code + "（" + bad.error + "）");

  const st = await svc.methods.status();
  assert.ok(st.cache.includes(SESSION_ID));
  console.log("✓ status 缓存 " + st.cache.length + " 条");

  await svc.dispose();
  gw.server.close();
  console.log("\n全部通过");
}

main().catch((e) => {
  console.error("\n失败：", e && e.stack ? e.stack : e);
  process.exit(1);
});
