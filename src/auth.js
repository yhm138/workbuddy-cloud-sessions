"use strict";

/**
 * 登录态：Playwright 持久化 profile，扫一次码长期复用。
 *
 * 为什么不能用系统 Chrome 的 profile：
 *   Chrome 的 cookie 库从 v127 起用 app-bound 加密（App-Bound Encryption），
 *   cookie 与可执行文件绑定，复制 profile 到别的浏览器实例读不出来，
 *   页面会直接跳回微信扫码页。必须用独立 profile 亲自登一次。
 */

const fs = require("fs");
const path = require("path");
const { PROFILE_DIR, WEB_ORIGIN } = require("./config");

function requirePlaywright() {
  try {
    return require("playwright");
  } catch {
    throw new Error(
      "缺少依赖 playwright。请先执行：\n  npm install\n  npx playwright install chromium"
    );
  }
}

/** 优先用系统 Chrome（渲染更接近真实），失败回退 Playwright 自带 Chromium */
async function launch(pw, opts = {}) {
  const args = ["--disable-blink-features=AutomationControlled"];
  const base = {
    headless: opts.headless !== false,
    args,
    viewport: { width: 1280, height: 820 },
    locale: "zh-CN",
  };
  const candidates = [{ ...base, channel: "chrome" }, base];
  let lastErr;
  for (const c of candidates) {
    try {
      return await pw.chromium.launchPersistentContext(PROFILE_DIR, c);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function openApp(ctx) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(45000);
  await page
    .goto(`${WEB_ORIGIN}/app`, { waitUntil: "domcontentloaded", timeout: 60000 })
    .catch(() => {});
  await page.waitForTimeout(2500);
  return page;
}

/** 用一条真实会话探活：能拿到 token 才算登录有效 */
async function probe(page, sessionId) {
  const r = await page.evaluate(async (id) => {
    try {
      const res = await fetch(`/console/as/conversations/${id}/session`, {
        headers: { accept: "application/json" },
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, data: json && json.data ? json.data : null };
    } catch (e) {
      return { status: 0, error: String(e && e.message) };
    }
  }, sessionId);
  return r;
}

function profileExists() {
  return fs.existsSync(path.join(PROFILE_DIR, "Default")) || fs.existsSync(PROFILE_DIR);
}

/**
 * 交互式登录：弹出有头浏览器，等用户扫码，然后验证登录态。
 * @returns {Promise<{ok:boolean, page?:object, ctx?:object, message:string}>}
 */
async function loginInteractive(sampleSessionId, opts = {}) {
  const pw = requirePlaywright();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await launch(pw, { headless: false });
  const page = await openApp(ctx);

  console.log("已打开浏览器窗口，请用微信扫码登录…（登录成功会自动继续）");

  let ok = false;
  for (let i = 0; i < 150; i++) {
    if (sampleSessionId) {
      const r = await probe(page, sampleSessionId);
      if (r.status === 200 && r.data && r.data.token) {
        ok = true;
        break;
      }
    } else {
      // 没有样本会话时，退化为看 URL 是否已离开登录页
      const u = page.url();
      if (!/\/auth\//.test(u) && /workbuddy\.cn/.test(u)) {
        ok = true;
        break;
      }
    }
    if (i % 10 === 0) process.stdout.write(".");
    await page.waitForTimeout(2000);
  }
  process.stdout.write("\n");

  if (opts.keepOpen) return { ok, page, ctx, message: ok ? "登录有效" : "未检测到登录态" };

  await ctx.close();
  return { ok, ctx: null, page: null, message: ok ? "登录有效" : "未检测到登录态" };
}

/** 用已有 profile 无头打开，返回 {ctx, page}，失败抛出 */
async function openWithProfile() {
  const pw = requirePlaywright();
  if (!profileExists()) {
    throw new Error(
      `没有找到登录态（${PROFILE_DIR}）。\n请先执行：node bin/wbcs.js login`
    );
  }
  const ctx = await launch(pw, { headless: true });
  const page = await openApp(ctx);
  return { ctx, page };
}

module.exports = { loginInteractive, openWithProfile, probe, profileExists, requirePlaywright };
