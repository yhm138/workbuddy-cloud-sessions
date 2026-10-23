"use strict";

/**
 * 面板 ↔ service 的联调自测（不联网、不要登录态）。
 *
 * 用一个「假宿主」页面把面板塞进 iframe，按真实协议建 MessagePort、回
 * guest-ready，并把 `$resolveLocalRpc` / `$invokeLocalRpcFallback` 转给
 * 真正的 server/index.cjs（后面连假网关）。
 *
 * 它验证的是**面板侧最容易写错的那半截**：通道名、参数顺序、票据复用、
 * 拉回来之后的渲染（「云端最新」提示条、列表条数）。真宿主只需要把
 * 假宿主替换掉、并真的 fork 子进程。
 *
 * 用法：node test/panel-service.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { chromium } = require("playwright");
const { startGateway, makeWb, SESSION_ID } = require("./mock-gateway.cjs");
const { activate } = require("../server/index.cjs");

const ROOT = path.resolve(__dirname, "..");
const NO_SERVICE = process.env.NO_SERVICE === "1";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml" };

function serve() {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404).end("no");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}

async function main() {
  const gw = await startGateway();
  const svc = activate(makeWb(gw.port()));
  const site = await serve();

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  const calls = [];

  await page.exposeFunction("hostInvoke", async (channel, args) => {
    calls.push(channel);
    if (channel === "wb:boundary:guest-ready") return {};
    if (channel === "wb:config:get") return "light";
    if (channel === "wb:http:get") {
      const url = String(args[0] || "");
      if (url.includes("/console/as/conversations/?")) {
        return {
          code: 0,
          msg: "OK",
          data: {
            conversations: [
              {
                id: SESSION_ID,
                name: "假会话",
                conversationOrigin: "agents",
                status: "completed",
                updatedAt: new Date().toISOString(),
              },
            ],
            total: 1,
            pagination: { page: 1, size: 20, total: 1, totalPages: 1, hasNext: false },
          },
        };
      }
      throw new Error("unexpected http url " + url);
    }
    if (channel === "wb:extensions:$resolveLocalRpc") {
      if (NO_SERVICE) throw Object.assign(new Error("测试：这次部署没有 service"), { code: "NO_SERVICE" });
      const [ext, method] = args;
      assert.strictEqual(ext, "cloud-sessions", "扩展 id 不对");
      assert.ok(typeof method === "string" && method, "method 必须是字符串");
      return {
        extensionId: ext,
        fallbackToken: "tok-" + method,
        fallbackExpiresAt: Date.now() + 300000,
        methods: ["ping", "fetchBody", "status", "inspect"],
        version: "1.9.1",
      };
    }
    if (channel === "wb:extensions:$invokeLocalRpcFallback") {
      const [ext, method, payload, token] = args;
      assert.strictEqual(ext, "cloud-sessions");
      assert.ok(typeof method === "string" && method, "method 必须是字符串");
      assert.ok(typeof token === "string" && token.startsWith("tok-"), "第 4 个参数必须是票据，实际：" + JSON.stringify(token));
      const fn = svc.methods[method];
      if (!fn) throw new Error("没有方法 " + method);
      /* 照抄真宿主的调用形状：主进程 invokeExtension(method, ...args) 会
       * transport.invoke(method, { callerId }, ...args)，到 service 进程里就是
       * fn(context, payload)。callerId 在这里故意留 undefined —— 真宿主没有
       * caller 时也是这样，v1.9.0 就是被这个形状坑成「缺少 id」。 */
      return await fn({ callerId: undefined }, payload);
    }
    throw new Error("假宿主没实现通道 " + channel);
  });

  page.on("pageerror", (e) => console.error("[panel error]", e.message));

  await page.goto(`http://127.0.0.1:${site.port}/test/host.html`, { waitUntil: "domcontentloaded" });
  const fr = page.frameLocator("#f");

  await page.waitForTimeout(2500);
  const diag = await fr.locator("#diag").textContent();
  console.log("--- 诊断 ---\n" + diag.split("\n").slice(0, 9).join("\n"));

  if (NO_SERVICE) {
    /* 降级场景：没有 service 时必须完全回到 1.8.0 的行为，不能白屏 */
    assert.ok(/云端直连\s*:\s*不可用/.test(diag), "没有 service 时诊断应显示不可用：" + diag);
    await fr.locator(".row").first().waitFor({ timeout: 30000 });
    await fr.locator(".row").first().click();
    await fr.locator("#dBody .uncached").waitFor({ timeout: 30000 });
    const txt = await fr.locator("#dBody").textContent();
    assert.ok(/完整内容在客户端/.test(txt), "降级时应该给「回到会话」落地卡：" + txt);
    console.log("✓ 无 service 时正常降级（落地卡）");
    await browser.close();
    site.server.close();
    gw.server.close();
    await svc.dispose();
    console.log("\n全部通过（降级模式）");
    return;
  }

  assert.ok(/云端直连\s*:\s*service v1\.9\.1/.test(diag), "面板没有认出 service：" + diag);

  // 自动同步 → 出现会话行
  await fr.locator(".row").first().waitFor({ timeout: 30000 });
  console.log("✓ 列表出现会话");

  // 预取或点开都会走 fetchBody；点开更直接
  await fr.locator(".row").first().click();
  await fr.locator("#dBody .snap.cloud").waitFor({ timeout: 60000 });
  const note = await fr.locator("#dBody .snap.cloud").textContent();
  const body = await fr.locator("#dBody").textContent();
  console.log("提示条：" + note.trim());
  assert.ok(/云端最新/.test(note), "缺少「云端最新」提示");
  assert.ok(body.includes("你好，在吗"), "正文没渲染出来");
  assert.ok(body.includes("在的，你说"), "assistant 消息没渲染出来");
  console.log("✓ 详情页显示云端正文");

  const sub = await fr.locator("#dSub").textContent();
  assert.ok(/云端最新/.test(sub), "副标题没标云端最新：" + sub);
  console.log("✓ 副标题：" + sub.trim());

  console.log("通道调用：" + [...new Set(calls)].join(" · "));
  assert.ok(calls.includes("wb:extensions:$resolveLocalRpc"));

  await browser.close();
  site.server.close();
  gw.server.close();
  await svc.dispose();
  console.log("\n全部通过");
}

main().catch((e) => {
  console.error("\n失败：", e && e.stack ? e.stack : e);
  process.exit(1);
});
