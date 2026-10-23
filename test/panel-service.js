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
const PKG_VERSION = require("../package.json").version;

const ROOT = path.resolve(__dirname, "..");
const NO_SERVICE = process.env.NO_SERVICE === "1";
const MP_SESSION_ID = "2070359399505326080";
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
  /* 记录面板发起的 window.open：宿主会把它接走交系统浏览器，这里只验证"有没有发起" */
  await page.addInitScript(() => {
    window.__OPENS = [];
    const orig = window.open;
    window.open = function (u, n, f) {
      window.__OPENS.push(String(u));
      try { return orig.call(window, u, n, f); } catch (e) { return null; }
    };
  });
  /* 底部输入条会写剪贴板，断言要能读回来 */
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
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
              {
                // 小程序来源：客户端里那条是空壳，点「回到会话」必须先问一句
                id: MP_SESSION_ID,
                name: "小程序来的会话",
                conversationOrigin: "workbuddy-mp",
                status: "completed",
                updatedAt: new Date().toISOString(),
              },
            ],
            total: 2,
            pagination: { page: 1, size: 20, total: 2, totalPages: 1, hasNext: false },
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
        version: PKG_VERSION,
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

  assert.ok(new RegExp("云端直连\\s*:\\s*service v" + PKG_VERSION.replace(/\\./g, "\\\.")).test(diag), "面板没有认出 service：" + diag);

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

  /* 面板只读：v1.11 把「在面板里打字」整个拿掉了 —— 跳过去填不进原会话，
   * 等于把用户写的话吞掉。宁可没有输入框，也不能骗人。 */
  assert.strictEqual(await fr.locator("#composer").count(), 0, "面板不该再有输入条");
  assert.strictEqual(await fr.locator("#cw").count(), 0, "面板不该再有输入框");

  const ec = fr.locator("#dBody .endcard").last();
  await ec.waitFor({ timeout: 5000 });
  const ecTxt = await ec.textContent();
  assert.ok(/面板只读/.test(ecTxt), "结束卡要说明面板只读：" + ecTxt);
  assert.ok(/到这里是全部 4 条/.test(ecTxt), "结束卡要显示条数：" + ecTxt);
  assert.ok(/在网页版打开/.test(ecTxt), "要有网页版出口：" + ecTxt);
  const ecPrimary = (await ec.locator("button.primary").textContent()).trim();
  assert.strictEqual(ecPrimary, "回融合会话继续", "桌面来源主按钮应指向融合会话，实际：" + ecPrimary);
  console.log("✓ 只读面板：没有输入框，末尾给两条出口（" + ecPrimary + " / 在网页版打开）");

  /* 网页版出口必须真的发起打开（宿主只放行 https，这里盯 window.open） */
  await ec.getByText("在网页版打开").click();
  await page.waitForTimeout(300);
  const opens = await fr.locator("#dBody").evaluate(() => (window.__OPENS || []).slice());
  assert.ok(opens.some((u) => /^https:\/\/www\.workbuddy\.cn\/app\/conversation\//.test(u)),
    "点网页版没发起打开：" + JSON.stringify(opens));
  console.log("✓ 网页版出口 → window.open(" + opens[opens.length - 1] + ")");

  /* 小程序来源的会话：「回到会话」不许直接跳进客户端的空壳，必须先给选择。 */
  await fr.locator("#back").click();     // 回到列表
  const mpRow = fr.locator('#listView .row[data-id="' + MP_SESSION_ID + '"]');
  await mpRow.hover();   // ↗ 按钮只在 hover 时出现
  await mpRow.locator(".row-go").click();
  await fr.locator("#pickModal:not([hidden])").waitFor({ timeout: 5000 });
  const pickSub = await fr.locator("#pickSub").textContent();
  const pickB = await fr.locator("#pickB").textContent();
  assert.ok(/暂无对话记录|只认桌面端/.test(pickSub), "要先说明客户端里为什么是空的：" + pickSub);
  assert.ok(/网页版/.test(pickB), "默认动作应该是网页版：" + pickB);
  console.log("✓ 小程序来源 → 先问去哪儿（" + pickB.trim() + "）");
  await fr.locator("#pickX").click();

  /* 小程序来源的详情页：客户端里只有空壳，出口要直接指向网页版 */
  await mpRow.locator(".body").click();
  const ecMp = fr.locator("#dBody .endcard").last();
  await ecMp.waitFor({ timeout: 45000 });
  const ecMpTxt = await ecMp.textContent();
  const ecMpPrimary = (await ecMp.locator("button.primary").textContent()).trim();
  assert.strictEqual(ecMpPrimary, "在网页版继续 ↗", "小程序来源主按钮应是网页版，实际：" + ecMpPrimary);
  assert.ok(/客户端里没有它的对话记录/.test(ecMpTxt), "要说明客户端里是空的：" + ecMpTxt);
  const dChatMp = (await fr.locator("#dChat").textContent()).trim();
  assert.strictEqual(dChatMp, "网页版继续", "顶栏主按钮也要跟着来源走，实际：" + dChatMp);
  console.log("✓ 小程序来源详情页 → 主出口是网页版（" + dChatMp + "）");
  await fr.locator("#back").click();

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
