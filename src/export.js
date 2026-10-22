"use strict";

/**
 * 导出 Markdown：一条会话一个 .md，外加 INDEX.md 总目录。
 * 适合归档、喂给别的模型、或搬到笔记软件里。
 */

const fs = require("fs");
const path = require("path");
const { ROOT, ORIGIN_LABEL } = require("./config");
const { readStore } = require("./fetch");
const { stamp } = require("./build");

function safeName(s) {
  return String(s || "untitled")
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "untitled";
}

function toMarkdown(it) {
  const lines = [];
  lines.push(`# ${it.title || "(无标题)"}`);
  lines.push("");
  lines.push(
    `> 来源：${ORIGIN_LABEL[it.origin] || it.origin || "未知"} · 会话 ID：\`${it.id}\` · ${
      it.ts ? stamp(it.ts) : "未知时间"
    }`
  );
  lines.push(`> 网页版：https://www.workbuddy.cn/app/conversation/${it.id}`);
  lines.push("");
  if (it.stats) {
    lines.push(
      `共 ${it.stats.total} 条消息（用户 ${it.stats.user} / 助手 ${it.stats.assistant} / 思考 ${it.stats.thought} / 工具 ${it.stats.tool}）`
    );
    lines.push("");
  }
  lines.push("---");
  lines.push("");

  const roleName = { u: "我", a: "助手", h: "思考", t: "工具" };
  for (const m of it.messages || []) {
    const r = m.r || "a";
    if (r === "t") {
      lines.push(`<details><summary>🔧 ${m.n || "工具调用"}${m.s ? " · " + m.s : ""}</summary>`);
      lines.push("");
      if (m.i) {
        lines.push("**输入**");
        lines.push("```");
        lines.push(m.i);
        lines.push("```");
      }
      if (m.o) {
        lines.push("**输出**");
        lines.push("```");
        lines.push(m.o);
        lines.push("```");
      }
      lines.push("");
      lines.push("</details>");
      lines.push("");
      continue;
    }
    if (r === "h") {
      lines.push(`<details><summary>💭 思考过程</summary>`);
      lines.push("");
      lines.push(m.t || "");
      lines.push("");
      lines.push("</details>");
      lines.push("");
      continue;
    }
    lines.push(`### ${roleName[r] || "消息"}`);
    lines.push("");
    lines.push(m.t || "");
    lines.push("");
  }
  return lines.join("\n");
}

function exportMarkdown(opts = {}) {
  const store = readStore();
  if (!store.items || !store.items.length) {
    throw new Error("没有抓取结果，先跑 fetch");
  }
  const outDir = path.resolve(opts.out || path.join(ROOT, "export"));
  fs.mkdirSync(outDir, { recursive: true });

  const rows = [];
  let n = 0;
  for (const it of store.items) {
    if (!it.ok) continue;
    if (opts.only && it.id !== opts.only) continue;
    const name = `${safeName(it.title)}-${String(it.id).slice(-6)}.md`;
    fs.writeFileSync(path.join(outDir, name), toMarkdown(it), "utf8");
    rows.push(`- [${it.title || "(无标题)"}](./${encodeURI(name)}) — ${ORIGIN_LABEL[it.origin] || it.origin} · ${stamp(it.ts)} · ${it.stats?.total || 0} 条`);
    n++;
  }

  fs.writeFileSync(
    path.join(outDir, "INDEX.md"),
    `# 云端会话导出\n\n导出时间：${stamp(Date.now())}\n\n共 ${n} 条。\n\n${rows.join("\n")}\n`,
    "utf8"
  );

  console.log(`已导出 ${n} 条 Markdown → ${outDir}`);
  return outDir;
}

module.exports = { exportMarkdown, toMarkdown };
