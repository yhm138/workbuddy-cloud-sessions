"use strict";

/**
 * 全局路径与平台探测。
 * 所有可变数据都在 .wbcs/ 下，仓库本身保持干净（.gitignore 已排除）。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

/** 数据目录：登录态、抓取结果、导出都在这里 */
const HOME = process.env.WBCS_HOME
  ? path.resolve(process.env.WBCS_HOME)
  : path.join(ROOT, ".wbcs");

const PROFILE_DIR = path.join(HOME, "profile"); // Playwright 持久登录态
const SESSIONS_JSON = path.join(HOME, "sessions.json"); // 抓取结果
const LOG_DIR = path.join(HOME, "logs");

const UI_DIR = path.join(ROOT, "ui");
const FULL_DIR = path.join(UI_DIR, "full");
const EXT_JSON = path.join(ROOT, "extension.json");
const DIST_JSON = path.join(ROOT, "distribution.json");

/** WorkBuddy 本地库（存会话元数据，不含正文） */
const DB_PATH = process.env.WBCS_DB
  ? path.resolve(process.env.WBCS_DB)
  : path.join(os.homedir(), ".workbuddy", "workbuddy.db");

/** 网页版基础地址 */
const WEB_ORIGIN = process.env.WBCS_WEB_ORIGIN || "https://www.workbuddy.cn";

const ORIGIN_LABEL = {
  agents: "网页版",
  "workbuddy-mp": "微信小程序",
  "workbuddy-app": "App",
  scheduler: "定时任务",
  "workbuddy-deploy": "部署任务",
  genie: "Genie",
  unknown: "未知来源",
};

/** 侧栏排序权重 */
const ORIGIN_ORDER = [
  "agents",
  "workbuddy-mp",
  "workbuddy-app",
  "scheduler",
  "workbuddy-deploy",
  "genie",
];

/**
 * 找 WorkBuddy 的扩展目录。
 * 客户端安装路径各平台不同，逐个候选探测；也支持 WORKBUDDY_RESOURCES_PATH 环境变量
 * （这个变量是 WorkBuddy 自己用的，指到 resources 目录）。
 */
function detectExtensionDirs() {
  const rel = ["resources", "extensions"];
  const out = [];

  const push = (resourcesDir) => {
    if (!resourcesDir) return;
    // 解包目录优先：app.asar.unpacked/resources/extensions
    const unpacked = path.join(resourcesDir, "app.asar.unpacked", ...rel);
    out.push(unpacked);
    // 开发版可能直接在 resources/extensions
    out.push(path.join(resourcesDir, ...rel));
  };

  if (process.env.WBCS_EXT_DIR) {
    return [path.resolve(process.env.WBCS_EXT_DIR)];
  }
  if (process.env.WORKBUDDY_RESOURCES_PATH) {
    push(process.env.WORKBUDDY_RESOURCES_PATH);
  }

  const home = os.homedir();
  if (process.platform === "win32") {
    const localApp = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const guesses = [
      path.join(localApp, "Programs", "WorkBuddy"),
      path.join(localApp, "Programs", "workbuddy"),
      path.join(pf, "WorkBuddy"),
      path.join(pf86, "WorkBuddy"),
      path.join(pf, "CodeBuddy"),
      "D:\\Software\\WorkBuddy",
      "C:\\Software\\WorkBuddy",
      path.join(home, "WorkBuddy"),
    ];
    for (const g of guesses) push(g);
  } else if (process.platform === "darwin") {
    push("/Applications/WorkBuddy.app/Contents");
    push(path.join(home, "Applications", "WorkBuddy.app", "Contents"));
  } else {
    push("/opt/WorkBuddy");
    push("/usr/lib/workbuddy");
    push(path.join(home, ".local", "share", "workbuddy"));
  }

  // 只保留真实存在、且像扩展根目录的
  return out.filter((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

function ensureHome() {
  for (const d of [HOME, LOG_DIR]) fs.mkdirSync(d, { recursive: true });
}

module.exports = {
  ROOT,
  HOME,
  PROFILE_DIR,
  SESSIONS_JSON,
  LOG_DIR,
  UI_DIR,
  FULL_DIR,
  EXT_JSON,
  DIST_JSON,
  DB_PATH,
  WEB_ORIGIN,
  ORIGIN_LABEL,
  ORIGIN_ORDER,
  detectExtensionDirs,
  ensureHome,
};
