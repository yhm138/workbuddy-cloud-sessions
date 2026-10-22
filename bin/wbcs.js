#!/usr/bin/env node
"use strict";

/**
 * wbcs — WorkBuddy Cloud Sessions CLI
 *
 *   wbcs login    扫一次码，登录态存到 .wbcs/profile（长期复用）
 *   wbcs list     只看本地 DB 里的云端会话清单（不联网）
 *   wbcs fetch    抓取正文（走 ACP 回放）
 *   wbcs build    生成静态数据分片
 *   wbcs deploy   装进 WorkBuddy 侧栏
 *   wbcs export   导出 Markdown
 *   wbcs serve    本地预览（不装扩展也能看）
 *   wbcs all      fetch + build + deploy
 */

const path = require("path");
const { ensureHome, ROOT } = require("../src/config");

const VERSION = require("../package.json").version;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out.flags[key] = next;
        i++;
      } else {
        out.flags[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function usage() {
  console.log(`wbcs ${VERSION} — WorkBuddy 云端会话工具

用法：
  wbcs login                 扫码登录（存 Playwright 持久 profile）
  wbcs list                  列出本地 DB 中的云端会话
  wbcs fetch [选项]          抓取会话正文
      --limit N              只抓前 N 条
      --only id1,id2         只抓指定会话
      --force                忽略缓存重抓
      --idle 4000            空闲判定（毫秒），网络慢可加大
  wbcs build                 生成 ui/data.js + ui/full/*.js
  wbcs deploy [--dest DIR]   装进 WorkBuddy 扩展目录（自动探测；客户端在跑会拒绝）
      --force                客户端在跑也照装（装完必须重启，否则面板报加载失败）
  wbcs export [--out DIR]    导出 Markdown
  wbcs serve [--port 8787]   本地预览（127.0.0.1）
  wbcs all [--force]         fetch + build + deploy

环境变量：
  WBCS_HOME                 数据目录（默认 <repo>/.wbcs）
  WBCS_DB                   workbuddy.db 路径（默认 ~/.workbuddy/workbuddy.db）
  WBCS_EXT_DIR              扩展目录（跳过自动探测）
  WORKBUDDY_RESOURCES_PATH  WorkBuddy 的 resources 目录
`);
}

async function main() {
  ensureHome();
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0] || "help";

  switch (cmd) {
    case "login": {
      const { loginInteractive } = require("../src/auth");
      const { listCloudSessions } = require("../src/db");
      let sample = null;
      try {
        sample = listCloudSessions()[0]?.id || null;
      } catch (e) {
        console.warn(`读取会话列表失败（不影响登录）：${e.message}`);
      }
      const r = await loginInteractive(sample);
      if (!r.ok) {
        console.error("登录未完成。请重试：wbcs login");
        process.exitCode = 1;
        return;
      }
      console.log("登录态已保存，可以执行：wbcs fetch");
      return;
    }

    case "list": {
      const { listCloudSessions } = require("../src/db");
      const rows = listCloudSessions();
      if (!rows.length) {
        console.log("本地 DB 里没有云端会话。");
        return;
      }
      const counts = {};
      for (const r of rows) counts[r.originLabel] = (counts[r.originLabel] || 0) + 1;
      console.log(`共 ${rows.length} 条：${JSON.stringify(counts)}\n`);
      for (const r of rows) {
        const d = new Date(r.ts || 0);
        const t = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
          d.getDate()
        ).padStart(2, "0")}`;
        console.log(`${t}  ${r.originLabel.padEnd(6)}  ${r.id}  ${r.title.slice(0, 40)}`);
      }
      return;
    }

    case "fetch": {
      const { fetchAll } = require("../src/fetch");
      await fetchAll({
        limit: flags.limit ? Number(flags.limit) : 0,
        only: typeof flags.only === "string" ? flags.only : "",
        force: !!flags.force,
        idleMs: flags.idle ? Number(flags.idle) : undefined,
        maxMs: flags.max ? Number(flags.max) : undefined,
      });
      return;
    }

    case "build": {
      const { build } = require("../src/build");
      build();
      return;
    }

    case "deploy": {
      const { deploy } = require("../src/deploy");
      deploy({ dest: flags.dest, force: !!flags.force });
      return;
    }

    case "export": {
      const { exportMarkdown } = require("../src/export");
      exportMarkdown({ out: flags.out, only: flags.only });
      return;
    }

    case "serve": {
      const { serve } = require("../src/serve");
      serve({ port: flags.port, open: !flags["no-open"] });
      return;
    }

    case "all": {
      const { fetchAll } = require("../src/fetch");
      const { build } = require("../src/build");
      const { deploy } = require("../src/deploy");
      await fetchAll({ force: !!flags.force });
      build();
      // --force 同时用于「重抓」和「客户端在跑也部署」，两个语义一致：跳过护栏
      deploy({ dest: flags.dest, force: !!flags.force });
      return;
    }

    case "help":
    case "--help":
    case "-h":
      usage();
      return;

    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return;

    default:
      console.error(`未知命令：${cmd}\n`);
      usage();
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  if (process.env.WBCS_DEBUG) console.error(e.stack);
  process.exitCode = 1;
});
