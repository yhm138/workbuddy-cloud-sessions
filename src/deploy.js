"use strict";

/**
 * 把构建产物部署成 WorkBuddy 内置扩展。
 *
 * 部署位置：<WorkBuddy>/resources/app.asar.unpacked/resources/extensions/<id>/
 * 走这个目录的扩展被视为 bundled（内置），免签名、免环境变量、placement=sidebar 直接生效。
 *
 * 两条硬约束（踩过坑，别改回去）：
 * 1. 先校验源产物，再动目标目录。否则「清空已装扩展 → 发现没 build」会把用户装好的扩展抹掉。
 * 2. 客户端运行时不要整目录删了重建。宿主在启动时会把扩展清单和文件快照缓存下来
 *    （页面 URL 上的 ?v=<启动时的版本>&wbs=bundled:<代号>），运行期把目录换掉，
 *    下一次打开面板宿主仍按旧快照去取文件 → 面板只显示「插件加载失败，请检查网络后重新加载」。
 *    所以这里改成「就地覆盖 + 只清理多余文件」，并且在客户端运行时默认拒绝，除非显式 --force。
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { UI_DIR, ROOT, detectExtensionDirs } = require("./config");

const EXTRA_FILES = ["extension.json", "distribution.json", "icon.svg", "README.md"];

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

function walk(dir, base = dir, out = new Set()) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, base, out);
    else out.add(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

function readExtId() {
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "extension.json"), "utf8"));
  return meta.id;
}

/** 客户端是否正在运行：bundled 扩展的清单是启动时快照的，运行期换文件必然对不上 */
function detectRunningClient() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq WorkBuddy.exe", "/NH"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      const n = (out.match(/WorkBuddy\.exe/gi) || []).length;
      return { running: n > 0, pids: n };
    }
    const out = execFileSync("pgrep", ["-f", "WorkBuddy"], { encoding: "utf8", timeout: 5000 });
    const pids = out.split("\n").filter(Boolean).length;
    return { running: pids > 0, pids };
  } catch (e) {
    // 查不到就当没运行，不要因此阻断部署
    return { running: false, pids: 0, unknown: true };
  }
}

/** 只删目标里本次没有的文件，绝不动根目录本身 */
function pruneStale(dest, keep) {
  const removed = [];
  for (const rel of walk(dest)) {
    if (keep.has(rel)) continue;
    // ui/ 与 server/ 是我们自己的产物；其余顶层文件也可能被宿主引用，保守一点只清这两处
    if (!rel.startsWith("ui/") && !rel.startsWith("server/")) continue;
    fs.rmSync(path.join(dest, rel), { force: true });
    removed.push(rel);
  }
  return removed;
}

function deploy(opts = {}) {
  const extId = readExtId();
  const targets = opts.dest ? [path.resolve(opts.dest)] : detectExtensionDirs();

  if (!targets.length) {
    throw new Error(
      "没有找到 WorkBuddy 扩展目录。\n" +
        "请手动指定：node bin/wbcs.js deploy --dest <path/to/app.asar.unpacked/resources/extensions>\n" +
        "或设置环境变量 WBCS_EXT_DIR / WORKBUDDY_RESOURCES_PATH"
    );
  }

  const dest = path.join(targets[0], extId);

  // 1. 先校验源产物，再动目标目录
  const mustSrc = ["extension.json", "ui/index.html", "ui/data.js", "server/index.cjs"];
  const missingSrc = mustSrc.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missingSrc.length) {
    throw new Error(
      `构建产物不完整（缺 ${missingSrc.join(", ")}）。先跑：node bin/wbcs.js build\n` +
        `已安装的扩展没有改动。`
    );
  }

  // 2. 安全护栏：只写 extensions/ 下的同名目录
  if (path.basename(targets[0]) !== "extensions") {
    throw new Error(`目标不像扩展根目录（应以 extensions 结尾）：${targets[0]}`);
  }

  // 3. 客户端在跑就别整目录换：宿主用的是启动时的清单快照
  const client = detectRunningClient();
  if (client.running && !opts.force) {
    throw new Error(
      `检测到 WorkBuddy 正在运行（${client.pids} 个进程）。\n\n` +
        "宿主的扩展清单是启动时快照的，运行期替换文件会导致侧栏面板只显示\n" +
        "「插件加载失败，请检查网络后重新加载」，重启前不会自愈。\n\n" +
        "请先完全退出 WorkBuddy（右下角托盘图标 → 退出，只关窗口不算），再执行：\n" +
        "  node bin/wbcs.js deploy\n\n" +
        "确实要热更新（当前面板已经坏了、准备立刻重启）：加 --force"
    );
  }

  // 4. 就地覆盖：不删根目录，避免宿主手里的路径在替换瞬间失效
  fs.mkdirSync(dest, { recursive: true });
  for (const f of EXTRA_FILES) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dest, f));
  }
  copyTree(UI_DIR, path.join(dest, "ui"));
  // fork 的 service（云端直连）：src/ 不部署，server/ 必须部署
  copyTree(path.join(ROOT, "server"), path.join(dest, "server"));

  // 5. 清掉上一版遗留的分片（先写后删，任何时刻都不缺文件）
  const keep = new Set(["extension.json", "distribution.json", "icon.svg", "README.md"]);
  for (const rel of walk(UI_DIR)) keep.add("ui/" + rel);
  for (const rel of walk(path.join(ROOT, "server"))) keep.add("server/" + rel);
  const removed = pruneStale(dest, keep);

  const must = ["extension.json", "ui/index.html", "ui/data.js", "server/index.cjs"];
  const missing = must.filter((f) => !fs.existsSync(path.join(dest, f)));
  if (missing.length) throw new Error(`部署不完整，缺少：${missing.join(", ")}`);

  let shards = 0;
  const fullDir = path.join(dest, "ui", "full");
  if (fs.existsSync(fullDir)) shards = fs.readdirSync(fullDir).length;

  const version = JSON.parse(fs.readFileSync(path.join(dest, "extension.json"), "utf8")).version;
  console.log(`已部署 → ${dest}`);
  console.log(`版本：${version}　正文分片：${shards} 个`);
  if (removed.length) console.log(`清理旧文件：${removed.length} 个`);
  if (client.running) {
    console.log("");
    console.log("⚠️  客户端仍在运行，本次是热更新：面板在重启前可能报「插件加载失败」。");
    console.log("   请完全退出 WorkBuddy（托盘退出）后重新打开，再点「云端会话」。");
  } else {
    console.log("启动 WorkBuddy 后，左侧菜单「云端会话」即为新版本。");
  }
  return dest;
}

module.exports = { deploy, detectExtensionDirs, detectRunningClient };
