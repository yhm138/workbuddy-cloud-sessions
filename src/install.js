"use strict";

/**
 * 一键安装 / 卸载（双击 安装.bat 走的就是这里）。
 *
 * 目标读者是「不想开终端的人」：每一步都要说人话，出错要告诉他下一步做什么，
 * 不要甩栈。步骤：
 *   1 找 WorkBuddy 扩展目录（找不到就让用户粘路径）
 *   2 要求完全退出客户端（宿主在启动时给扩展清单拍快照，运行期换文件必坏）
 *   3 复用登录态，没有就弹浏览器扫码
 *   4 抓正文（默认只抓最近 30 条，避免第一次就等十几分钟）
 *   5 build + deploy，告诉他重启客户端
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { HOME, ROOT, PROFILE_DIR, detectExtensionDirs, ensureHome } = require("./config");

const VERSION = require("../package.json").version;

/* ------------------------------- 输出小工具 ------------------------------- */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c("1");
const dim = c("2");
const green = c("32");
const yellow = c("33");
const red = c("31");
const cyan = c("36");

function line(msg = "") {
  process.stdout.write(msg + "\n");
}

function step(n, total, title) {
  line("");
  line(`${dim(`[${n}/${total}]`)} ${bold(title)}`);
}

function ok(msg) {
  line(`      ${green("✓")} ${msg}`);
}

function warn(msg) {
  line(`      ${yellow("!")} ${msg}`);
}

function bad(msg) {
  line(`      ${red("✗")} ${msg}`);
}

function indent(msg) {
  for (const l of String(msg).split("\n")) line(`        ${l}`);
}

/* -------------------------------- 交互 -------------------------------- */

let rl = null;

function ask(question, opts = {}) {
  if (!process.stdin.isTTY || opts.nonInteractive) return Promise.resolve(opts.default ?? "");
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (a) => resolve(String(a).trim()));
  });
}

async function pause(text = "按回车继续…") {
  await ask(dim(text));
}

function closeRl() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

/** 数字选择，非法输入重问（最多 5 次，之后取默认值） */
async function choose(question, options, def = 1) {
  line(question);
  options.forEach((o, i) => line(`   ${cyan(String(i + 1))}) ${o}`));
  for (let i = 0; i < 5; i++) {
    const a = await ask(`选择 [${def}]: `);
    if (!a) return def;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n;
    line(yellow("   请输入上面的序号。"));
  }
  return def;
}

/* ------------------------------ 步骤实现 ------------------------------ */

function pickExtDir() {
  const dirs = detectExtensionDirs();
  if (dirs.length) return dirs[0];
  return null;
}

function looksLikeExtRoot(p) {
  return path.basename(path.resolve(p)) === "extensions";
}

/** 目标目录能不能写（Program Files 下需要管理员） */
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.wbcs-write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

async function waitClientExited() {
  const { detectRunningClient } = require("./deploy");
  let st = detectRunningClient();
  if (!st.running) return true;

  warn(`检测到 WorkBuddy 正在运行（${st.pids} 个进程）`);
  line("      宿主的扩展清单是启动时拍的快照，运行期换文件会让面板报「插件加载失败」。");
  line("      请右键右下角托盘图标 → 退出（只关窗口不算），然后重新运行本程序。");
  if (!process.stdin.isTTY) return false;

  for (let i = 0; i < 20; i++) {
    const a = await ask(dim("\n      退出后按回车重试，输入 q 取消："));
    if (/^q$/i.test(a)) return false;
    st = detectRunningClient();
    if (!st.running) return true;
    warn(`还在运行（${st.pids} 个进程）——记得是托盘图标右键退出，不是点窗口的 ×`);
  }
  return false;
}

function describeAuthError(e) {
  const msg = String((e && e.message) || e);
  if (/401|403|登录态已失效/.test(msg)) {
    return "登录态失效了（网页版可能要重新扫码）。选 1 重新登录一次，之后长期有效。";
  }
  if (/没有找到登录态/.test(msg)) return "还没有登录过，需要扫码一次。";
  return msg;
}

async function doLogin() {
  const { loginInteractive } = require("./auth");
  const { listCloudSessions } = require("./db");
  let sample = null;
  try {
    sample = listCloudSessions()[0]?.id || null;
  } catch {
    /* 没 DB 也能登录，只是探活方式退化 */
  }
  const r = await loginInteractive(sample);
  return r.ok;
}

/**
 * 抓取；遇到登录失效时给一次重登重试的机会。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function runFetch(opts) {
  const { fetchAll } = require("./fetch");
  try {
    await fetchAll(opts);
    return { ok: true };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!/401|403|登录态已失效|没有找到登录态/.test(msg)) return { ok: false, error: msg };
    warn(describeAuthError(e));
    const n = await choose("要现在重新登录吗？", ["重新扫码登录，然后接着抓", "跳过抓取，只装一个空面板"], 1);
    if (n !== 1) return { ok: false, skipped: true };
    const logged = await doLogin();
    if (!logged) return { ok: false, error: "登录没有完成（没检测到有效的登录态）。" };
    try {
      await fetchAll(opts);
      return { ok: true };
    } catch (e2) {
      return { ok: false, error: String((e2 && e2.message) || e2) };
    }
  }
}

/* -------------------------------- 主流程 -------------------------------- */

async function install(opts = {}) {
  const auto = !!opts.yes || !process.stdin.isTTY;
  ensureHome();

  line("");
  line(bold(`  WorkBuddy 云端会话 · 一键安装  v${VERSION}`));
  line(dim("  把网页版 / 微信小程序 / 定时任务里的会话搬进桌面端侧栏"));

  const TOTAL = 5;

  /* 1. 找扩展目录 */
  step(1, TOTAL, "找 WorkBuddy 的扩展目录");
  let extRoot = opts.dest ? path.resolve(opts.dest) : pickExtDir();

  if (extRoot && !looksLikeExtRoot(extRoot)) {
    bad(`这个路径不像扩展根目录（应以 extensions 结尾）：${extRoot}`);
    extRoot = null;
  }
  if (!extRoot) {
    bad("没找到 WorkBuddy 的安装目录。");
    indent("常见位置：C:\\Users\\<你>\\AppData\\Local\\Programs\\WorkBuddy");
    indent("也可以右键桌面上的 WorkBuddy 图标 → 打开文件所在位置，");
    indent("把地址栏里的路径粘到下面（通常再加 \\resources\\app.asar.unpacked\\resources\\extensions）。");
    const typed = await ask("      粘贴 extensions 目录路径（直接回车退出）：");
    if (!typed) {
      closeRl();
      return { ok: false, error: "no-extension-dir" };
    }
    extRoot = path.resolve(typed.replace(/^["']|["']$/g, ""));
    if (!looksLikeExtRoot(extRoot)) {
      bad(`路径不对：${extRoot}`);
      closeRl();
      return { ok: false, error: "bad-extension-dir" };
    }
  }
  ok(extRoot);

  if (!writable(extRoot)) {
    bad("这个目录需要管理员权限才能写入。");
    indent("请关闭本窗口，右键 安装.bat → 「以管理员身份运行」。");
    closeRl();
    return { ok: false, error: "need-admin" };
  }

  /* 2. 客户端必须退出 */
  step(2, TOTAL, "确认 WorkBuddy 已完全退出");
  if (opts.force) {
    warn("已按 --force 跳过运行检测：本次是热更新，面板在重启前可能报「插件加载失败」");
  } else if (!(await waitClientExited())) {
    bad("已取消。请退出 WorkBuddy 后再双击 安装.bat。");
    closeRl();
    return { ok: false, error: "client-running" };
  } else {
    ok("客户端未运行");
  }

  /* 3. 登录态 */
  step(3, TOTAL, "检查登录态");
  const { profileExists } = require("./auth");
  if (opts.relogin) {
    warn("按要求重新登录");
    if (!(await doLogin())) {
      bad("登录没有完成。请重试：双击 安装.bat");
      closeRl();
      return { ok: false, error: "login-failed" };
    }
    ok("登录态已保存");
  } else if (profileExists()) {
    ok("已有登录态，直接复用（失效时会在抓取阶段提示重登）");
  } else {
    warn("还没有登录过。马上会弹出一个浏览器窗口，请用微信扫码登录 WorkBuddy 网页版。");
    line(dim("      扫完不用关窗口，检测到登录成功会自动继续。"));
    await pause();
    if (!(await doLogin())) {
      bad("没检测到登录态。可以重新双击 安装.bat 再试一次。");
      closeRl();
      return { ok: false, error: "login-failed" };
    }
    ok("登录成功，登录态已保存（下次不用再扫）");
  }

  /* 4. 抓取 */
  step(4, TOTAL, "抓取会话正文");
  let total = 0;
  let sessionError = null;
  try {
    const { listCloudSessions } = require("./db");
    total = listCloudSessions().length;
  } catch (e) {
    bad("读不到本机的会话清单：" + String((e && e.message) || e).split("\n")[0]);
    indent("请先打开 WorkBuddy 登录一次（让它生成本地数据库），再运行安装。");
    closeRl();
    return { ok: false, error: "no-db" };
  }
  ok(`本机记录 ${total} 条云端会话`);

  let limit = 0;
  let skipFetch = !!opts.skipFetch;
  if (!total) {
    warn("一条云端会话都没有：你可能还没在网页版/小程序里用过，或客户端还没同步过。");
    indent("先装个空面板也能用，以后在面板里点「同步」即可。");
    skipFetch = true;
  } else if (!skipFetch) {
    if (opts.limit) limit = Number(opts.limit);
    else if (!auto) {
      const n = await choose("抓取范围？", [
        `最近 30 条（推荐，约 3 分钟）`,
        `全部 ${total} 条（更慢，看网络）`,
        "先不抓，只装面板（之后在面板里随时同步）",
      ], 1);
      if (n === 3) skipFetch = true;
      else if (n === 2) limit = 0;
      else limit = 30;
    } else {
      limit = 30;
    }
  }

  if (skipFetch) {
    warn("跳过抓取，稍后仍可在面板里刷新");
  } else {
    line(dim(`      抓取 ${limit ? `最近 ${Math.min(limit, total)} 条` : `全部 ${total} 条`}，可随时 Ctrl+C 中断，已抓到的不会丢。`));
    line("");
    const r = await runFetch({ limit, force: !!opts.force });
    if (!r.ok) {
      sessionError = r.error || "抓取中断";
      bad("抓取没有全部完成");
      indent(sessionError);
      indent("已抓到的部分会保留，安装继续。装好后可以在面板里点「同步」补齐。");
    }
  }

  /* 5. 构建 + 部署 */
  step(5, TOTAL, "生成面板并装进客户端");
  const { build } = require("./build");
  const { deploy } = require("./deploy");
  let dest = null;
  try {
    build({ allowEmpty: true });
    ok("面板数据已生成");
    dest = deploy({ dest: extRoot, force: !!opts.force });
  } catch (e) {
    bad("安装失败：" + String((e && e.message) || e).split("\n")[0]);
    closeRl();
    return { ok: false, error: String((e && e.message) || e) };
  }

  const parsedVersion = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dest, "extension.json"), "utf8")).version;
    } catch {
      return VERSION;
    }
  })();
  const shardsDir = path.join(dest, "ui", "full");
  let shards = 0;
  try {
    shards = fs.readdirSync(shardsDir).filter((f) => f.endsWith(".js") && f !== "index.js" && f !== "_search.js").length;
  } catch {
    /* 空面板 */
  }
  ok(`已安装 v${parsedVersion} → ${dest}`);
  ok(shards ? `${shards} 条会话带正文` : "当前还没有正文（可在面板里点「同步」）");

  line("");
  line(green(bold("  装好了。最后一步：")));
  line("  1. 打开 WorkBuddy");
  line("  2. 左侧菜单点「云端会话」");
  line(dim("     （菜单没有这一项，说明客户端是装在后台运行的：托盘右键退出，再打开一次）"));
  line("");
  line(dim(`  数据目录：${HOME}`));
  line(dim(`  卸载：双击 uninstall.bat，或 node bin/wbcs.js uninstall`));

  if (sessionError) line(yellow("\n  提示：这次正文没抓全，不影响面板打开。"));
  closeRl();
  return { ok: true, dest, shards, total, sessionError };
}

/* -------------------------------- 卸载 -------------------------------- */

async function uninstall(opts = {}) {
  const { detectRunningClient } = require("./deploy");
  const extRoot = opts.dest ? path.resolve(opts.dest) : pickExtDir();
  ensureHome();

  line("");
  line(bold("  WorkBuddy 云端会话 · 卸载"));
  if (!extRoot) {
    bad("没找到 WorkBuddy 扩展目录，可能已经卸载过了。");
    return { ok: false, error: "no-extension-dir" };
  }

  const st = detectRunningClient();
  if (st.running && opts.force) {
    warn("已按 --force 跳过运行检测：重启客户端前，侧栏里可能残留一项点不开的入口");
  } else if (st.running) {
    if (!(await waitClientExited())) {
      closeRl();
      return { ok: false, error: "client-running" };
    }
  }

  const target = path.join(extRoot, "cloud-sessions");
  if (!fs.existsSync(target)) {
    ok("客户端里没有安装过，无需卸载。");
  } else {
    fs.rmSync(target, { recursive: true, force: true });
    ok("已从客户端移除「云端会话」");
  }

  const delData = await choose("要一并删除登录态和抓好的正文吗？", ["保留（下次重装不用再扫码）", "删除"], 1);
  if (delData === 2) {
    fs.rmSync(HOME, { recursive: true, force: true });
    ok(`已删除数据目录 ${HOME}`);
  } else {
    ok(`数据保留在 ${HOME}`);
  }

  line("");
  line(dim("  重启 WorkBuddy 后，侧栏里这一项就消失了。"));
  closeRl();
  return { ok: true };
}

module.exports = { install, uninstall };
