"use strict";

/**
 * 把构建产物部署成 WorkBuddy 内置扩展。
 *
 * 部署位置：<WorkBuddy>/resources/app.asar.unpacked/resources/extensions/<id>/
 * 走这个目录的扩展被视为 bundled（内置），免签名、免环境变量、placement=sidebar 直接生效。
 */

const fs = require("fs");
const path = require("path");
const { UI_DIR, ROOT, detectExtensionDirs } = require("./config");

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readExtId() {
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "extension.json"), "utf8"));
  return meta.id;
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

  // 先校验源产物，再动目标目录：避免「清空了已装扩展才发现没 build」
  const mustSrc = ["extension.json", "ui/index.html", "ui/data.js"];
  const missingSrc = mustSrc.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missingSrc.length) {
    throw new Error(
      `构建产物不完整（缺 ${missingSrc.join(", ")}）。先跑：node bin/wbcs.js build\n` +
        `已安装的扩展没有改动。`
    );
  }

  // 安全护栏：只清空 extensions/ 下的同名目录，避免误删
  if (path.basename(targets[0]) !== "extensions") {
    throw new Error(`目标不像扩展根目录（应以 extensions 结尾）：${targets[0]}`);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  for (const f of ["extension.json", "distribution.json", "icon.svg", "README.md"]) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dest, f));
  }
  copyTree(UI_DIR, path.join(dest, "ui"));

  // 校验关键文件
  const must = ["extension.json", "ui/index.html", "ui/data.js"];
  const missing = must.filter((f) => !fs.existsSync(path.join(dest, f)));
  if (missing.length) throw new Error(`部署不完整，缺少：${missing.join(", ")}`);

  let shards = 0;
  const fullDir = path.join(dest, "ui", "full");
  if (fs.existsSync(fullDir)) shards = fs.readdirSync(fullDir).length;

  console.log(`已部署 → ${dest}`);
  console.log(`正文分片：${shards} 个`);
  console.log("重启 WorkBuddy 客户端后，左侧菜单「云端会话」即为新版本。");
  return dest;
}

module.exports = { deploy, detectExtensionDirs };
