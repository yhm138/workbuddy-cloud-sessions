/**
 * Guest 握手自检：用真实 Chrome 起一个「假宿主」，看 ui/index.html 能不能
 * 在 10s 内发出 wb:boundary:guest-ready 并响应 wb:invoke:request。
 *
 *   node test/run-handshake.js
 *
 * 退出码 0 = 通过。
 */
const path = require("path");
const { pathToFileURL } = require("url");

let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch (e) {
  try {
    ({ chromium } = require("playwright"));
  } catch (e2) {
    console.error("缺少依赖，请先执行：npm i playwright-core --no-save");
    process.exit(2);
  }
}

const CHANNEL = process.env.WBCS_CHANNEL || "chrome";

(async () => {
  const file = pathToFileURL(path.join(__dirname, "handshake.html")).href;
  const browser = await chromium.launch({ channel: CHANNEL, headless: true });
  const page = await browser.newPage();
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(m.text()));
  page.on("pageerror", (e) => consoleLines.push("PAGEERROR " + e.message));

  await page.goto(file);
  await page.waitForTimeout(7000);

  const title = await page.title();

  // 进 guest iframe 里看主题是否被宿主返回的 "dark" 应用上
  let theme = "?";
  for (const f of page.frames()) {
    try {
      const t = await f.evaluate(() => ({
        theme: document.documentElement.dataset.theme || "",
        rows: document.querySelectorAll("#listView .row").length,
        diag: (document.getElementById("diag") || {}).textContent || ""
      }));
      if (t && (t.theme || t.rows)) { theme = t.theme || "(空)"; if (t.diag) console.log("—— guest 诊断 ——\n" + t.diag); break; }
    } catch (e) {}
  }

  const log = await page.$eval("#log", (el) => el.innerText).catch(() => "");
  await browser.close();

  console.log(log.trim());
  const pass = title === "READY_OK" && theme === "dark";
  console.log("\ntheme=" + theme);
  console.log((pass ? "PASS" : "FAIL") + "  title=" + title);
  if (!pass) {
    console.log("—— 页面 console ——");
    consoleLines.slice(-20).forEach((l) => console.log("  " + l));
  }
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error("运行失败:", e.message);
  process.exit(2);
});
