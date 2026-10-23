"use strict";

/**
 * 浏览器启动兜底链。
 *
 * 为什么需要它：小白装完没有 `npx playwright install chromium` 这一步，
 * 几百 MB 的浏览器下载不能指望。好在 Windows 一定自带 Edge，多数人装了 Chrome，
 * 而 WorkBuddy 桌面端自己的浏览器功能也会在 %LOCALAPPDATA%\ms-playwright 放一份 Chromium。
 * 依次尝试，能开就行。
 *
 * 为什么要把选择「钉死」：
 *   Edge 和 Chrome 往同一个 profile 目录写 cookie，加密密钥不同（Chrome 127+ 还加了
 *   app-bound 加密）。这次用 Chrome 登录、下次用 Edge 读，读出来是空 → 又跳回扫码页。
 *   所以第一次成功后把浏览器记到 <WBCS_HOME>/browser.json，之后优先用它。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { HOME } = require("./config");

const PIN_FILE = path.join(HOME, "browser.json");

function firstLine(s) {
  return String(s || "").split("\n")[0].slice(0, 160);
}

/** 找本机已经存在的 Chromium（WorkBuddy 自带 / 其它工具装过） */
function findLocalChromium() {
  const roots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== "0") {
    roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    roots.push(path.join(local, "ms-playwright"));
  } else if (process.platform === "darwin") {
    roots.push(path.join(os.homedir(), "Library", "Caches", "ms-playwright"));
  } else {
    roots.push(path.join(os.homedir(), ".cache", "ms-playwright"));
  }

  const rels =
    process.platform === "win32"
      ? ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"]
      : process.platform === "darwin"
        ? ["chrome-mac/Chromium.app/Contents/MacOS/Chromium"]
        : ["chrome-linux/chrome"];

  const found = [];
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of dirs) {
      if (!/^chromium-\d+$/.test(name)) continue;
      for (const rel of rels) {
        const p = path.join(root, name, ...rel.split("/"));
        try {
          if (fs.statSync(p).isFile()) found.push({ exe: p, rev: Number(name.split("-")[1]) });
        } catch {
          /* 没有就算了 */
        }
      }
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => b.rev - a.rev); // 版本新的优先
  return found[0].exe;
}

function readPin() {
  try {
    return JSON.parse(fs.readFileSync(PIN_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writePin(pin) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(PIN_FILE, JSON.stringify(pin, null, 2), "utf8");
  } catch {
    /* 记不住就算了，不影响主流程 */
  }
}

/** 候选顺序：上次成功的 → 系统 Chrome → 系统 Edge → 本机 Chromium → Playwright 自带 */
function candidates() {
  const list = [
    { key: "chrome", label: "系统 Chrome", opt: { channel: "chrome" } },
    { key: "msedge", label: "系统 Edge", opt: { channel: "msedge" } },
  ];
  const local = findLocalChromium();
  if (local) {
    list.push({ key: "local:" + local, label: "本机 Chromium（WorkBuddy 自带）", opt: { executablePath: local } });
  }
  list.push({ key: "bundled", label: "Playwright 自带 Chromium", opt: {} });

  const pin = readPin();
  const key = pin && pin.key;
  if (key) {
    const i = list.findIndex((c) => c.key === key);
    if (i > 0) list.unshift(list.splice(i, 1)[0]);
  }
  return list;
}

/**
 * 打开一个持久化 profile 的浏览器上下文。
 * @param {object} pw        require("playwright")
 * @param {string} profileDir
 * @param {{headless?:boolean, timeout?:number}} opts
 * @returns {Promise<{ctx:object, label:string, key:string}>}
 */
async function launch(pw, profileDir, opts = {}) {
  fs.mkdirSync(profileDir, { recursive: true });
  const base = {
    headless: opts.headless !== false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    viewport: { width: 1280, height: 820 },
    locale: "zh-CN",
  };

  const errs = [];
  for (const c of candidates()) {
    try {
      const ctx = await pw.chromium.launchPersistentContext(profileDir, { ...base, ...c.opt });
      writePin({ key: c.key, label: c.label, exe: c.opt.executablePath || null });
      return { ctx, label: c.label, key: c.key };
    } catch (e) {
      errs.push(`· ${c.label}：${firstLine(e.message)}`);
    }
  }

  throw new Error(
    "没有可用的浏览器。请任选一项后重试：\n" +
      "  1) 安装 Chrome 或 Microsoft Edge\n" +
      "  2) 在项目目录执行：npx playwright install chromium\n\n" +
      "细节：\n" +
      errs.join("\n")
  );
}

module.exports = { launch, findLocalChromium, readPin, writePin, PIN_FILE };
