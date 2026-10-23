#!/usr/bin/env node
/**
 * 生成 README 用的演示截图。
 *
 * 关键点：截图里的会话全部是内置的假数据，不读 .wbcs/、不读 workbuddy.db，
 * 所以图片可以直接进公开仓库。渲染方式是把 ui/index.html 拷到临时目录，
 * 配上 mock 的 data.js / full/*.js，再用无头浏览器打开 file:// 截图。
 *
 *   node tools/demo-shots.js            # 输出到 docs/images/
 *   node tools/demo-shots.js --out tmp  # 换输出目录
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return path.resolve(ROOT, i > 0 && process.argv[i + 1] ? process.argv[i + 1] : "docs/images");
})();

const T0 = Date.UTC(2026, 9, 23, 1, 40, 0); // 2026-10-23 09:40 +08:00
const H = 3600e3;
const D = 24 * H;

/** writeDemo 里挑出来的那条详情会话，供假 service 返回 */
let DETAIL_REC = null;

/** 会话列表：字段与 wbcs build 生成的 data.js 完全一致 */
const ITEMS = [
  { id: "1000000000000000001", title: "为团队整理一份 API 设计评审清单", origin: "agents", ts: T0 - 2 * H, created: T0 - 5 * H, status: "completed", n: 24, t: 6, ok: true },
  { id: "1000000000000000002", title: "把三季度区域销售数据整理成对比表", origin: "agents", ts: T0 - 26 * H, created: T0 - 30 * H, status: "completed", n: 46, t: 12, ok: true },
  { id: "1000000000000000003", title: "调研开源 OCR 方案的识别准确率与成本", origin: "workbuddy-mp", ts: T0 - 3 * H, created: T0 - 4 * H, status: "completed", n: 62, t: 18, ok: true },
  { id: "1000000000000000004", title: "每日 9:00 汇总行业资讯并推送", origin: "scheduler", ts: T0 - 40 * 60e3, created: T0 - 9 * D, status: "completed", n: 8, t: 3, ok: true },
  { id: "1000000000000000005", title: "撰写客户跟进邮件（英文，正式语气）", origin: "workbuddy-mp", ts: T0 - 1.2 * D, created: T0 - 1.2 * D, status: "completed", n: 12, t: 2, ok: true },
  { id: "1000000000000000006", title: "重构登录模块的错误处理与重试逻辑", origin: "agents", ts: T0 - 2.4 * D, created: T0 - 2.4 * D, status: "completed", n: 88, t: 31, ok: true },
  { id: "1000000000000000007", title: "整理 30 篇论文的摘要与主要结论", origin: "workbuddy-mp", ts: T0 - 3.1 * D, created: T0 - 3.1 * D, status: "completed", n: 35, t: 9, ok: true },
  { id: "1000000000000000008", title: "每周一生成项目周报草稿", origin: "scheduler", ts: T0 - 4 * D, created: T0 - 12 * D, status: "completed", n: 6, t: 1, ok: true },
];

/** 详情页用的那条会话：五类消息都覆盖到（用户 / 思考 / 工具 / 回答） */
const DETAIL = [
  ["u", "帮我给团队出一份 API 设计评审清单，覆盖命名、错误码、分页、幂等和向后兼容。", "", "", "", "", ""],
  ["h", "要的是能直接拿去评审的清单，不是泛泛的原则。先看团队现有规范覆盖了哪些，再补缺口：命名、错误码分层、分页、幂等、兼容性。", "", "", "", "", ""],
  ["t", "", "fetch", "Fetch https://example.com/api-style-guide", "completed",
    '{\n  "url": "https://example.com/api-style-guide",\n  "prompt": "提取接口命名、错误码、分页相关的规范条目"\n}',
    "已提取 24 条规范：命名 9 条、错误码 6 条、分页 5 条、兼容性 4 条。其中 409 冲突码与幂等要求缺失。"],
  ["a", "我把现有规范和你说的五个维度做了对齐，缺口集中在**幂等**和**兼容性**。\n\n### 评审清单\n\n| 维度 | 要确认的事 | 现状 |\n| --- | --- | --- |\n| 命名 | 资源用复数，动作用子路径 | 基本统一 |\n| 错误码 | 4xx 区分参数 / 权限 / 冲突 | 缺 409 |\n| 分页 | 游标优先，offset 只用于小数据 | 全是 offset |\n| 幂等 | 写接口带 `Idempotency-Key` | 未实现 |\n| 兼容性 | 只增字段，不删不改类型 | 有破坏性变更 |\n\n### 评审时只问三个问题\n\n1. 这个接口被重试两次会发生什么？\n2. 分页翻到第 100 页要多久？\n3. 客户端升级滞后 6 个月还能用吗？", "", "", "", ""],
  ["a", "需要的话我可以把这份清单导成 Markdown，直接贴进评审模板。", "", "", "", "", ""],
];

function writeDemo(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "full"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "ui/index.html"), path.join(dir, "index.html"));

  /* 假宿主壳：把面板放进 iframe，和真实客户端一致（顶层面板会走另一条降级路径） */
  fs.writeFileSync(
    path.join(dir, "host.html"),
    '<!doctype html><meta charset="utf-8"><title>panel</title>\n' +
      "<style>html,body{margin:0;padding:0;height:100%;background:#fff;overflow:hidden}" +
      "iframe{border:0;display:block;width:100%;height:100%}</style>\n" +
      '<iframe id="f" src="./index.html"></iframe>\n'
  );

  const counts = {};
  for (const it of ITEMS) counts[it.origin] = (counts[it.origin] || 0) + 1;

  const LABELS = {
    agents: "网页版",
    "workbuddy-mp": "微信小程序",
    "workbuddy-app": "App",
    scheduler: "定时任务",
    "workbuddy-deploy": "部署任务",
    genie: "Genie",
    unknown: "未知来源",
  };

  const data = {
    generatedAt: "2026-10-23 09:40",
    generatedAtMs: T0,
    total: ITEMS.length,
    counts,
    originLabels: LABELS,
    originOrder: ["agents", "workbuddy-mp", "workbuddy-app", "scheduler", "workbuddy-deploy", "genie"],
    webOrigin: "https://www.workbuddy.cn",
    items: ITEMS.slice()
      .sort((a, b) => b.ts - a.ts)
      .map((it) => ({ ...it, originLabel: LABELS[it.origin] || it.origin })),
  };

  fs.writeFileSync(
    path.join(dir, "data.js"),
    "// demo data for screenshots — 全部为示例内容，不含真实会话\n" +
      "window.CLOUD_SESSIONS=" + JSON.stringify(data) + ";\n"
  );

  for (const it of ITEMS) {
    const messages =
      it.id === ITEMS[0].id
        ? DETAIL
        : [["u", it.title + "。", "", "", "", "", ""], ["a", "（示例会话，仅用于截图）", "", "", "", "", ""]];
    const stats = {
      total: messages.length,
      user: messages.filter((m) => m[0] === "u").length,
      assistant: messages.filter((m) => m[0] === "a").length,
      thought: messages.filter((m) => m[0] === "h").length,
      tool: messages.filter((m) => m[0] === "t").length,
    };
    const rec = {
      id: it.id, title: it.title, origin: it.origin, ok: true, error: "",
      count: messages.length, stats, messages,
      /* 下面三个字段让「云端最新」提示条能显示成真实的样子 */
      fetchedAt: T0, events: it.id === ITEMS[0].id ? 142 : 9, source: "acp",
    };
    if (it.id === ITEMS[0].id) DETAIL_REC = rec;
    fs.writeFileSync(
      path.join(dir, "full", it.id + ".js"),
      "window.__WBCS_SESSION__(" + JSON.stringify(rec) + ");\n"
    );
  }

  const bytes = 4096;
  const index = {
    generatedAt: T0,
    total: ITEMS.length,
    bytes: bytes * ITEMS.length,
    items: ITEMS.map((it) => ({ id: it.id, n: it.n, b: bytes, ok: true })),
  };
  fs.writeFileSync(path.join(dir, "full", "index.js"), "window.__WBCS_INDEX__=" + JSON.stringify(index) + ";\n");
  fs.writeFileSync(path.join(dir, "full", "_search.js"), 'window.__WBCS_SEARCH__={"generatedAt":0,"items":[]};\n');
  return dir;
}

async function shots(dir) {
  const { chromium } = require("playwright");
  const launch = async () => {
    try {
      return await chromium.launch({ channel: "msedge" });
    } catch (e) {
      return await chromium.launch();
    }
  };
  const browser = await launch();
  /* 面板跑在 iframe 里才是真实形态：只有 iframe 会等宿主投递 MessagePort，
     顶层的 file:// 页面会被当成纯浏览器环境直接降级。 */
  const hostUrl = "file:///" + path.join(dir, "host.html").replace(/\\/g, "/");
  fs.mkdirSync(OUT, { recursive: true });

  /**
   * 假 service：让详情截图呈现「云端最新」的真实样子，而不是降级后的快照。
   * 走真实通道 —— 先给页面塞一个 MessagePort（宿主就这么干的），再在另一头应答。
   */
  const FAKE_SERVICE = (arg) => {
    const rec = arg.rec;
    const V = arg.version;
    try {
      // 让「进面板预取」跳过其它会话，截图里就不会闪进度条
      const fail = {};
      for (const id of arg.others) fail[id] = Date.now();
      localStorage.setItem("wbcs.pullFail", JSON.stringify(fail));
    } catch (e) {}

    const reply = (port, requestId, result) =>
      port.postMessage({ type: "wb:invoke:response", requestId, result });

    const answer = (port, d) => {
      const a = d.args || [];
      if (d.channel === "wb:boundary:guest-ready") return reply(port, d.requestId, { ok: true });
      if (d.channel === "wb:extensions:$resolveLocalRpc") {
        return reply(port, d.requestId, {
          extensionId: "cloud-sessions",
          fallbackToken: "demo-token",
          fallbackExpiresAt: Date.now() + 300000,
          methods: ["ping", "status", "inspect", "fetchBody", "peek", "warm", "clear"],
          version: V,
          serviceInstanceId: "demo",
        });
      }
      if (d.channel === "wb:extensions:$invokeLocalRpcFallback") {
        const method = a[1];
        const payload = a[2] || {};
        if (method === "ping") {
          return reply(port, d.requestId, { ok: true, version: V, pid: 24380, uptime: 913, ports: [], cache: 1 });
        }
        if (method === "status") {
          return reply(port, d.requestId, { ok: true, version: V, pid: 24380, cache: [rec.id], inflight: [], active: 0, waiting: 0, calls: [] });
        }
        if (method === "peek") {
          return reply(port, d.requestId, { ok: true, live: false, n: rec.messages.length, messages: rec.messages, events: rec.events });
        }
        if (method === "fetchBody") {
          return reply(port, d.requestId, payload.id === rec.id
            ? { ok: true, cached: false, elapsed: 120, shard: rec }
            : { ok: true, cached: false, elapsed: 60, shard: { id: payload.id, ok: true, messages: [], stats: {} } });
        }
      }
      return reply(port, d.requestId, { ok: true });
    };

    const boot = () => {
      /* 宿主给 iframe 投递 MessagePort 就是这么做的；这里只是把另一头留在本进程里应答 */
      const ch = new MessageChannel();
      ch.port1.addEventListener("message", (ev) => {
        const d = ev.data;
        if (!d || d.type !== "wb:invoke:request") return;
        answer(ch.port1, d);
      });
      try { ch.port1.start(); } catch (e) {}
      window.postMessage({ type: "__wb_port_init__", readyToken: "demo" }, "*", [ch.port2]);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => setTimeout(boot, 0));
    } else {
      setTimeout(boot, 0);
    }
  };

  const open = async (withService) => {
    const page = await browser.newPage({ viewport: { width: 400, height: 840 }, deviceScaleFactor: 2 });
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    if (withService) {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
      await page.addInitScript(FAKE_SERVICE, {
        rec: DETAIL_REC,
        version: pkg.version,
        others: ITEMS.filter((x) => x.id !== DETAIL_REC.id).map((x) => x.id),
      });
    }
    await page.goto(hostUrl);
    /* 没有 service 的页面要等面板把「等宿主 port」的 4s 熬完 */
    await page.waitForTimeout(withService ? 1800 : 5200);
    page.__errs = errs;
    const fr = page.frameLocator("#f");
    await fr.locator("#listView, #detailView").first().waitFor({ timeout: 15000 });
    return { page, fr };
  };

  // 1) 列表
  let { page: p, fr } = await open();
  await p.screenshot({ path: path.join(OUT, "list.png") });
  await p.close();

  // 2) 快照降级弹窗（故意不装 service）
  ({ page: p, fr } = await open());
  await fr.locator('.row[data-id="' + ITEMS[0].id + '"]').click();
  await p.waitForTimeout(1400);
  await p.screenshot({ path: path.join(OUT, "modal.png") });
  await p.close();

  // 3) 详情（假 service → 「云端最新」）
  ({ page: p, fr } = await open(true));
  await fr.locator('.row[data-id="' + ITEMS[0].id + '"]').click();
  await p.waitForTimeout(1600);
  await p.screenshot({ path: path.join(OUT, "detail.png") });
  await p.close();

  // 4) 统计
  ({ page: p, fr } = await open());
  await fr.locator("#listMore").click();
  await p.waitForTimeout(200);
  await fr.locator("#statsBtn").click();
  await p.waitForTimeout(600);
  await p.screenshot({ path: path.join(OUT, "stats.png") });
  await p.close();

  await browser.close();
  console.log("截图输出：" + OUT);
  for (const f of ["list.png", "detail.png", "modal.png", "stats.png"]) {
    const fp = path.join(OUT, f);
    if (fs.existsSync(fp)) console.log("  " + f + "  " + Math.round(fs.statSync(fp).size / 1024) + " KB");
  }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wbcs-demo-"));
  try {
    writeDemo(tmp);
    await shots(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
