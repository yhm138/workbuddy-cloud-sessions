"use strict";

/**
 * 本地自测：不开客户端，直接把 server/index.cjs 当成宿主 fork 出来的 service 跑一遍。
 *
 * 用一个假 wb 把 `http.get` 接到已登录的 Playwright 页面上（就是宿主 `wb.http.get`
 * 做的事：带 cookie 请求 workbuddy.cn），所以能真实走通
 *   票据 → SSE 回放 → 解析 → 返回 shard
 * 这条链路，只差「宿主真的 fork 了它」这一步需要在客户端里验证。
 *
 * 用法：
 *   node tools/test-service.js            # 取本地最新一条会话
 *   node tools/test-service.js <id>       # 指定会话
 */

const { activate } = require("../server/index.cjs");
const { openWithProfile } = require("../src/auth");
const { listCloudSessions } = require("../src/db");

async function main() {
  const arg = process.argv[2];
  const list = listCloudSessions();
  const target = arg ? { id: arg, title: "(指定)" } : list[0];
  if (!target) {
    console.error("本地没有会话可测");
    process.exit(2);
  }
  console.log(`样本：${target.id} ${String(target.title || "").slice(0, 30)}`);

  const t0 = Date.now();
  const { ctx, page } = await openWithProfile();
  console.log(`浏览器就绪 ${Math.round((Date.now() - t0) / 1000)}s`);

  // 假的宿主 wb：http.get 用页面内 fetch（带 cookie、不受 CORS 限制）
  const wb = {
    http: {
      async get(url) {
        const r = await page.evaluate(async (u) => {
          try {
            const res = await fetch(u, { headers: { accept: "application/json" } });
            const text = await res.text();
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {}
            return { status: res.status, json, text: text.slice(0, 300) };
          } catch (e) {
            return { status: 0, error: String((e && e.message) || e) };
          }
        }, url);
        if (r.status !== 200) {
          const e = new Error(`HTTP ${r.status || r.error} ${r.text || ""}`.trim());
          e.status = r.status;
          throw e;
        }
        return r.json;
      },
    },
    async invoke() {
      throw new Error("本测试没有实现 wb.invoke");
    },
  };

  const svc = activate(wb);

  const ping = await svc.methods.ping();
  console.log("ping:", JSON.stringify(ping));

  const info = await svc.methods.inspect({ id: target.id });
  console.log("inspect:", JSON.stringify(info));

  for (const force of [false, true]) {
    const t = Date.now();
    const r = await svc.methods.fetchBody({ id: target.id, force });
    const ms = Date.now() - t;
    if (!r.ok) {
      console.error(`fetchBody(force=${force}) 失败：`, r.code, r.error);
      await ctx.close();
      process.exit(1);
    }
    console.log(
      `fetchBody(force=${force}) → ${r.shard.messages.length} 条 / ${r.shard.events} 事件` +
        ` · cached=${r.cached} · ${ms}ms · ${r.shard.reason}`
    );
    const sample = r.shard.messages.slice(0, 3).map((m) => `${m.r}:${String(m.t || m.n || "").slice(0, 24)}`);
    console.log("  样本:", sample.join(" | "));
  }

  const st = await svc.methods.status();
  console.log("status.cache:", st.cache, "active:", st.active);
  console.log("recent:\n  " + st.recent.slice(-6).join("\n  "));

  await ctx.close();
  await svc.dispose();
  console.log("\nOK");
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
