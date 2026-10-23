#!/usr/bin/env node
"use strict";

/**
 * 生成 Windows 便携安装包（GitHub Release 附件）：
 *
 *   dist/workbuddy-cloud-sessions-<ver>-win-x64/
 *     install.bat        双击即装（ASCII 名，任何解压工具都稳）
 *     安装.bat           同上，中文名，给习惯点中文的人
 *     uninstall.bat      卸载
 *     使用说明.txt
 *     runtime/node.exe   便携 Node（省掉「先装 Node」这一步）
 *     app/               本项目 + playwright 依赖
 *   dist/workbuddy-cloud-sessions-<ver>-win-x64.zip
 *   dist/...zip.sha256
 *
 * 为什么自带 node：小白卡在「装 Node、配 PATH、npm install」的概率接近 100%，
 * 而 node.exe 就 90 MB，压完 30 MB，值。
 *
 * 为什么不带 Chromium：Windows 一定有 Edge，多数人有 Chrome，
 * src/browser.js 会依次兜底；带一份 Chromium 要多 150 MB。
 *
 * 用法：npm run release   （或 node tools/build-release.js）
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const VERSION = require(path.join(ROOT, "package.json")).version;
const NODE_VERSION = process.env.WBCS_NODE_VERSION || "22.22.2";
const PKG_NAME = `workbuddy-cloud-sessions-${VERSION}-win-x64`;

const DIST = path.join(ROOT, "dist");
const STAGE = path.join(DIST, PKG_NAME);
const CACHE = path.join(ROOT, ".cache");
const NODE_ZIP = path.join(CACHE, `node-v${NODE_VERSION}-win-x64.zip`);
const OUT_ZIP = path.join(DIST, `${PKG_NAME}.zip`);

const APP_ITEMS = [
  "bin",
  "src",
  "server",
  "extension.json",
  "distribution.json",
  "icon.svg",
  "package.json",
  "README.md",
  "LICENSE",
];

const LAUNCHERS = ["install.bat", "安装.bat", "uninstall.bat", "使用说明.txt"];

const MB = (n) => (n / 1024 / 1024).toFixed(1) + " MB";

function log(msg) {
  console.log(msg);
}

/* ------------------------------- 文件工具 ------------------------------- */

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyTree(src, dst, filter) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      const s = path.join(src, name);
      const d = path.join(dst, name);
      if (filter && !filter(s, d)) continue;
      copyTree(s, d, filter);
    }
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else total += st.size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return total;
}

/* -------------------------------- 下载 -------------------------------- */

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("重定向次数过多"));
    const req = https.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return download(next, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      }
      const total = Number(res.headers["content-length"] || 0);
      let got = 0;
      let lastPct = -1;
      const tmp = dest + ".part";
      const out = fs.createWriteStream(tmp);
      res.on("data", (chunk) => {
        got += chunk.length;
        if (total) {
          const pct = Math.floor((got / total) * 100);
          if (pct !== lastPct && pct % 10 === 0) {
            lastPct = pct;
            process.stdout.write(`   ${pct}%  ${MB(got)} / ${MB(total)}\r`);
          }
        }
      });
      res.pipe(out);
      out.on("finish", () => {
        out.close(() => {
          fs.renameSync(tmp, dest);
          process.stdout.write("            \r");
          resolve(dest);
        });
      });
      out.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("下载超时"));
    });
  });
}

async function ensureNodeExe(runtimeDir) {
  const target = path.join(runtimeDir, "node.exe");
  if (fs.existsSync(target)) {
    log(`· runtime/node.exe 已就绪（${MB(fs.statSync(target).size)}）`);
    return target;
  }
  fs.mkdirSync(CACHE, { recursive: true });
  if (!fs.existsSync(NODE_ZIP)) {
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`;
    log(`· 下载 Node v${NODE_VERSION} …`);
    await download(url, NODE_ZIP);
  }
  log(`· 解出 node.exe …`);
  fs.mkdirSync(runtimeDir, { recursive: true });
  try {
    execFileSync("unzip", ["-o", "-j", NODE_ZIP, "*/node.exe", "-d", runtimeDir], {
      stdio: "pipe",
    });
  } catch (e) {
    throw new Error(
      `解压 node.exe 失败（需要 unzip 命令）：${String(e.message).split("\n")[0]}`
    );
  }
  if (!fs.existsSync(target)) throw new Error("解压后没找到 node.exe");
  log(`· runtime/node.exe ${MB(fs.statSync(target).size)}`);
  return target;
}

/* ------------------------------ 打包 ------------------------------ */

async function main() {
  log(`\n打包 workbuddy-cloud-sessions v${VERSION}（Windows x64 便携版）\n`);

  // 0. 只能装干净的 ui：本地 build 出来的 data.js / full 含真实会话，绝不能进包
  for (const bad of ["ui/data.js", "ui/full"]) {
    if (fs.existsSync(path.join(ROOT, bad))) {
      throw new Error(
        `发现本地构建产物 ${bad}。它是真实会话数据，不能进安装包。\n` +
          "先删掉再打包：rm -rf ui/data.js ui/full"
      );
    }
  }

  // 1. 目录
  rmrf(STAGE);
  fs.mkdirSync(STAGE, { recursive: true });

  // 2. app/
  const appDir = path.join(STAGE, "app");
  fs.mkdirSync(appDir, { recursive: true });
  for (const item of APP_ITEMS) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) throw new Error(`缺少 ${item}`);
    copyTree(src, path.join(appDir, item));
  }
  // ui 只带 index.html（及其它静态资源），数据由安装时生成
  copyTree(path.join(ROOT, "ui"), path.join(appDir, "ui"), (s) => {
    const rel = path.relative(path.join(ROOT, "ui"), s).split(path.sep).join("/");
    return rel === "index.html" || !/^(data\.js|full)/.test(rel);
  });

  // 3. 运行时依赖（playwright 只依赖 playwright-core）
  const nm = path.join(appDir, "node_modules");
  for (const dep of ["playwright", "playwright-core"]) {
    const src = path.join(ROOT, "node_modules", dep);
    if (!fs.existsSync(src)) throw new Error(`缺少依赖 node_modules/${dep}，先 npm install`);
    log(`· 复制 node_modules/${dep} …`);
    copyTree(src, path.join(nm, dep));
  }
  // 体积自负：地图文件与类型声明用不上
  const prune = (dir, re) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) prune(p, re);
      else if (re.test(name)) fs.rmSync(p, { force: true });
    }
  };
  prune(nm, /\.(map|md|markdown)$/i);

  // 4. Node 运行时
  await ensureNodeExe(path.join(STAGE, "runtime"));

  // 5. 启动器 + 说明（说明写成 UTF-8 带 BOM，记事本直接打开不乱码）
  for (const f of LAUNCHERS) {
    const src = path.join(ROOT, "tools", "release", f);
    if (!fs.existsSync(src)) throw new Error(`缺少启动器模板 ${f}`);
    let buf = fs.readFileSync(src);
    if (f.endsWith(".txt")) buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]);
    fs.writeFileSync(path.join(STAGE, f), buf);
  }

  // 6. 自检：不该有本地数据
  const leaked = ["app/ui/data.js", "app/ui/full", "app/.wbcs"].filter((p) =>
    fs.existsSync(path.join(STAGE, p))
  );
  if (leaked.length) throw new Error(`安装包里混进了本地数据：${leaked.join(", ")}`);

  const rawSize = dirSize(STAGE);
  log(`· 解包后 ${MB(rawSize)}`);

  // 7. 压缩（-UN=UTF8 保证中文文件名在 Windows 资源管理器里能正常解出）
  if (fs.existsSync(OUT_ZIP)) fs.rmSync(OUT_ZIP);
  log(`· 压缩 …`);
  try {
    execFileSync("zip", ["-r", "-q", "-UN=UTF8", OUT_ZIP, PKG_NAME], {
      cwd: DIST,
      stdio: "pipe",
    });
  } catch (e) {
    throw new Error(`压缩失败（需要 zip 命令，Info-ZIP 3.0+）：${String(e.message).split("\n")[0]}`);
  }

  const zipSize = fs.statSync(OUT_ZIP).size;
  const sha = crypto.createHash("sha256").update(fs.readFileSync(OUT_ZIP)).digest("hex");
  fs.writeFileSync(OUT_ZIP + ".sha256", `${sha}  ${path.basename(OUT_ZIP)}\n`, "utf8");

  log("");
  log(`完成：${path.relative(ROOT, OUT_ZIP)}  ${MB(zipSize)}`);
  log(`sha256：${sha}`);
  log(`目录：${path.relative(ROOT, STAGE)}`);
  log("");
  log("下一步：");
  log(`  gh release create v${VERSION} "${path.relative(ROOT, OUT_ZIP)}" \\`);
  log(`    --title "v${VERSION}" --notes-file docs/RELEASE-v${VERSION}.md`);
  return { stage: STAGE, zip: OUT_ZIP, sha, zipSize, rawSize };
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  process.exitCode = 1;
});
