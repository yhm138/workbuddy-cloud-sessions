#!/usr/bin/env node
/**
 * 录一张 README 用的动图：分组列表 → 读云端正文 → 一键回融合会话接着说。
 *
 * 思路和 demo-shots.js 一样（假数据、假宿主、无头浏览器），只是把「截图」
 * 换成「逐帧截图 + ffmpeg 合成」：每一帧的状态（光标位置、滚动位置、输入框
 * 里的字）都由脚本显式设置，所以动画是确定的，不会因为机器快慢而抖。
 *
 *   node tools/demo-gif.js                  # → docs/images/continue.gif
 *   node tools/demo-gif.js --scale 1        # 一半分辨率（文件更小）
 *   node tools/demo-gif.js --keep           # 保留帧目录，方便挑错
 *
 * 动图第三幕是「客户端融合会话」的示意页（tools/demo-client.html），
 * 不是真实客户端截图：真实客户端里用户的会话内容不该出现在公开仓库里。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { writeDemo, fakeService, ITEMS, OUT, detailRec } = require("./demo-shots");

const ROOT = path.resolve(__dirname, "..");
const argOf = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const W = 400;
const H = 840;
const SCALE = Number(argOf("scale", 2)); // 2x：和 docs/images/*.png 同分辨率，点开原图能看清字
const FPS = 12.5; // 80ms / 帧：够顺，又不至于把 gif 撑大
const OUT_FILE = path.join(OUT, "continue.gif");

/* stage：把面板和客户端示意页叠在一起，中间那层是给读者看的光标。
   面板必须是 iframe —— 只有 iframe 会等宿主投递 MessagePort 走真实链路。 */
const STAGE = `<!doctype html><meta charset="utf-8"><title>stage</title>
<style>
  html,body{margin:0;padding:0;width:${W}px;height:${H}px;overflow:hidden;background:#fff}
  #pa,#cl{position:absolute;left:0;top:0;width:${W}px;height:${H}px}
  #cl{opacity:0;pointer-events:none}   /* 透明的顶层 iframe 会吃掉面板的鼠标事件 */
  iframe{border:0;display:block;width:${W}px;height:${H}px;background:#fff}
  #cur{position:absolute;left:0;top:0;width:22px;height:22px;opacity:0;z-index:9;
       pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.3))}
  #rip{position:absolute;left:0;top:0;width:0;height:0;opacity:0;z-index:8;
       pointer-events:none;border:2px solid rgba(0,0,0,.32);border-radius:50%;
       transform:translate(-50%,-50%)}
  /* 切场的白闪：两页文字直接交叉淡化会糊成一团，先过一下白更干净 */
  #white{position:absolute;left:0;top:0;width:${W}px;height:${H}px;background:#fff;opacity:0;z-index:10;pointer-events:none}
</style>
<div id="pa"><iframe id="f" src="./index.html"></iframe></div>
<div id="cl"><iframe id="g" src="./client.html"></iframe></div>
<div id="white"></div>
<div id="rip"></div>
<svg id="cur" viewBox="0 0 22 22"><path d="M0 0 L0 16.6 L4.4 12.5 L7.3 18.3 L10.2 16.9 L7.4 11.2 L13.6 10.8 Z"
  fill="#111" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>
<script>
  var cur=document.getElementById('cur'),rip=document.getElementById('rip'),cl=document.getElementById('cl');
  window.__d={
    show:function(v){cur.style.opacity=v?1:0;},
    cur:function(x,y){cur.style.left=x+'px';cur.style.top=y+'px';},
    rip:function(x,y,r,o){var d=document.getElementById('rip');
      d.style.left=x+'px';d.style.top=y+'px';d.style.width=(r*2)+'px';d.style.height=(r*2)+'px';d.style.opacity=o;},
    fade:function(o){cl.style.opacity=o;cl.style.pointerEvents=o>.9?'auto':'none';},
    white:function(o){document.getElementById('white').style.opacity=o;}
  };
</script>`;

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const lerp = (a, b, t) => a + (b - a) * t;

(async () => {
  const { chromium } = require("playwright");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wbcs-gif-"));
  const framesDir = path.join(tmp, "frames");
  fs.mkdirSync(framesDir, { recursive: true });

  try {
    writeDemo(tmp);
    fs.writeFileSync(path.join(tmp, "stage.html"), STAGE);
    fs.copyFileSync(path.join(__dirname, "demo-client.html"), path.join(tmp, "client.html"));

    /* 优先用系统 Edge（与 demo-shots 一致），装不上再退回 playwright 自带 chromium */
    let browser;
    try {
      browser = await chromium.launch({ channel: "msedge" });
    } catch (e) {
      browser = await chromium.launch();
    }
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
    const page = await ctx.newPage();
    ctx.on("page", (p) => p.close().catch(() => {})); // 深链的 window.open 会被拦下来，别让它抢镜

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const rec = detailRec();
    await page.addInitScript(fakeService, {
      rec,
      version: pkg.version,
      others: ITEMS.filter((x) => x.id !== rec.id).map((x) => x.id),
    });

    await page.goto("file:///" + path.join(tmp, "stage.html").replace(/\\/g, "/"));
    const fr = page.frameLocator("#f");
    const cl = page.frameLocator("#g");
    await fr.locator("#listView").waitFor({ timeout: 20000 });
    await cl.locator("#field").waitFor({ timeout: 20000 });
    /* FrameLocator 只能定位，跑脚本要拿真正的 Frame */
    const cf = page.frames().find((f) => f.url().includes("client.html"));

    let n = 0;
    const shot = async () => {
      await page.screenshot({
        path: path.join(framesDir, String(++n).padStart(4, "0") + ".png"),
        animations: "allow",
      });
    };
    const hold = async (k) => { for (let i = 0; i < k; i++) await shot(); };

    /* 鼠标位置 = 真实指针位置（触发 :hover / :active）+ 画面上的假光标 */
    const pointer = async (x, y) => {
      await page.mouse.move(x, y);
      await page.evaluate(([x, y]) => window.__d.cur(x, y), [x, y]);
    };
    const moveTo = async (x0, y0, x1, y1, steps) => {
      for (let i = 1; i <= steps; i++) {
        const t = easeOut(i / steps);
        await pointer(lerp(x0, x1, t), lerp(y0, y1, t));
        await shot();
      }
    };
    const ripple = async (x, y, k) => {
      for (let i = 0; i < k; i++) {
        await page.evaluate(([x, y, r, o]) => window.__d.rip(x, y, r, o), [x, y, 5 + i * 7, 0.45 - i * 0.11]);
        await shot();
      }
      await page.evaluate(() => window.__d.rip(0, 0, 0, 0));
    };

    /* ---------------- 第一幕：分组列表 ---------------- */
    const row = fr.locator('.row[data-id="' + ITEMS[0].id + '"]');
    const rb = await row.boundingBox();
    const rx = rb.x + Math.min(rb.width * 0.55, 210);
    const ry = rb.y + rb.height / 2;

    await pointer(352, 792);
    await page.evaluate(() => window.__d.show(1));
    await hold(5);
    await moveTo(352, 792, rx, ry, 15);
    await hold(5); // 停在标题上，让 hover 高亮出来
    await pointer(rx, ry);
    await page.mouse.down();
    await shot();
    await page.mouse.up();
    await ripple(rx, ry, 4);

    /* ---------------- 第二幕：详情 + 出口按钮 ---------------- */
    await fr.locator(".endcard").waitFor({ timeout: 15000 });
    await hold(5);

    const m = await fr.locator("main").evaluate((el) => ({ max: el.scrollHeight - el.clientHeight }));
    if (m.max > 12) {
      const steps = Math.min(14, Math.max(6, Math.round(m.max / 90)));
      for (let i = 1; i <= steps; i++) {
        const y = m.max * easeOut(i / steps);
        await fr.locator("main").evaluate((el, y) => { el.scrollTop = y; }, y);
        await shot();
      }
    }
    await hold(7);

    const btn = fr.locator(".endcard .ea button.primary");
    const bb = await btn.boundingBox();
    const bx = bb.x + bb.width / 2;
    const by = bb.y + bb.height / 2;
    const cx = bx + 90;
    const cy = by + 130;
    await moveTo(cx, cy, bx, by, 12);
    await hold(3);
    await page.mouse.down();
    await shot();
    await page.mouse.up();
    await ripple(bx, by, 4);
    await hold(9); // 按钮文案变「正在切过去…」+ 底部 toast

    /* ---------------- 第三幕：客户端融合会话（示意） ---------------- */
    /* 白闪 → 换页 → 淡出；光标趁遮罩还在的时候挪到输入框，别让读者看到它瞬移 */
    for (const o of [0.4, 0.75, 1]) {
      await page.evaluate((o) => window.__d.white(o), o);
      await shot();
    }
    await page.evaluate(() => window.__d.fade(1));
    const box = await cl.locator("#box").boundingBox();
    /* 光标停在输入框右下角的空白处：别压住正在打出来的字 */
    const fx = box.x + 262;
    const fy = box.y + 40;
    await page.mouse.move(fx, fy);
    await page.evaluate(([x, y]) => window.__d.cur(x, y), [fx, fy]);
    for (const o of [0.75, 0.42, 0.14, 0]) {
      await page.evaluate((o) => window.__d.white(o), o);
      await shot();
    }
    await hold(4);
    await cf.evaluate(() => window.__demo.focus(true));
    await hold(3);

    const TEXT = "按这份清单，帮我把下周三的评审会排个议程";
    for (let i = 2; i <= TEXT.length; i += 2) {
      await cf.evaluate((t) => window.__demo.text(t), TEXT.slice(0, i));
      await shot();
    }
    await cf.evaluate((t) => window.__demo.text(t), TEXT);
    await shot();
    await hold(3);

    const sb = await cl.locator("#send").boundingBox();
    const sx = sb.x + sb.width / 2;
    const sy = sb.y + sb.height / 2;
    await moveTo(fx + 40, fy, sx, sy, 5);
    await page.mouse.down();
    await shot();
    await page.mouse.up();
    await cf.evaluate(() => window.__demo.send());
    await ripple(sx, sy, 3);
    await pointer(sx - 40, sy + 6);
    await hold(2);
    await cf.evaluate(() => window.__demo.thinking());
    await hold(14);

    await browser.close();

    /* ---------------- 合成 gif ---------------- */
    const palette = [
      "split[a][b]",
      "[a]palettegen=max_colors=128:stats_mode=diff[p]",
      "[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
    ].join(";");
    execFileSync("ffmpeg", [
      "-y", "-loglevel", "error",
      "-framerate", String(FPS),
      "-i", path.join(framesDir, "%04d.png"),
      "-vf", palette,
      "-loop", "0",
      OUT_FILE,
    ], { stdio: "inherit" });

    const kb = Math.round(fs.statSync(OUT_FILE).size / 1024);
    console.log("动图输出：" + OUT_FILE + "  " + n + " 帧 · " + kb + " KB");
    if (kb > 6000) console.log("提醒：超过 6 MB，考虑把帧数或宽度压一压");
  } finally {
    if (process.argv.includes("--keep")) console.log("帧目录已保留：" + tmp);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
