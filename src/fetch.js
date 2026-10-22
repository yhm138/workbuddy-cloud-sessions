"use strict";

/**
 * 全量抓取：会话元数据（本地 DB）→ 每条会话换 token → ACP 回放 → 解析 → 落盘。
 * 结果写到 .wbcs/sessions.json（原子写入，中断不丢已完成的部分）。
 */

const fs = require("fs");
const path = require("path");
const { SESSIONS_JSON, WEB_ORIGIN } = require("./config");
const { listCloudSessions } = require("./db");
const { loadSession } = require("./acp");
const { parseEvents } = require("./parse");
const { openWithProfile } = require("./auth");

function readStore() {
  if (!fs.existsSync(SESSIONS_JSON)) return { generatedAt: 0, items: [] };
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_JSON, "utf8"));
  } catch {
    return { generatedAt: 0, items: [] };
  }
}

function writeStore(store) {
  store.generatedAt = Date.now();
  const tmp = `${SESSIONS_JSON}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store), "utf8");
  fs.renameSync(tmp, SESSIONS_JSON);
}

/** 用已登录页面换单条会话的 token + 消息服务地址 */
async function fetchSessionInfo(page, id) {
  const r = await page.evaluate(async (sid) => {
    try {
      const res = await fetch(`/console/as/conversations/${sid}/session`, {
        headers: { accept: "application/json" },
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, data: (json && json.data) || null };
    } catch (e) {
      return { status: 0, error: String((e && e.message) || e) };
    }
  }, id);
  return r;
}

/**
 * @param {object} opts
 * @param {number} [opts.limit]     只抓前 N 条
 * @param {string} [opts.only]      只抓指定 id（逗号分隔）
 * @param {boolean} [opts.force]    忽略已有结果重抓
 * @param {number} [opts.idleMs]    空闲判定超时
 * @param {number} [opts.maxMs]     单条硬超时
 */
async function fetchAll(opts = {}) {
  const idleMs = opts.idleMs || 4000;
  const maxMs = opts.maxMs || 120000;

  let list = listCloudSessions();
  if (opts.only) {
    const want = new Set(String(opts.only).split(",").map((s) => s.trim()).filter(Boolean));
    list = list.filter((s) => want.has(s.id));
  }
  if (opts.limit > 0) list = list.slice(0, opts.limit);
  if (!list.length) {
    console.log("没有待抓的会话（检查本地 DB 或 --only 参数）");
    return readStore();
  }

  const store = readStore();
  const byId = new Map((store.items || []).map((it) => [it.id, it]));
  const targets = opts.force
    ? list
    : list.filter((s) => {
        const prev = byId.get(s.id);
        return !prev || !prev.ok;
      });

  console.log(
    `会话共 ${list.length} 条，已缓存 ${
      list.filter((s) => byId.get(s.id)?.ok).length
    } 条，本次待抓 ${targets.length} 条`
  );
  if (!targets.length) {
    console.log("全部命中缓存，跳过抓取（要重抓加 --force）");
    return store;
  }

  const { ctx, page } = await openWithProfile();

  // 先探一次，登录态失效就别浪费时间
  const first = targets[0];
  const probe = await fetchSessionInfo(page, first.id);
  if (probe.status === 401 || probe.status === 403) {
    await ctx.close();
    throw new Error(
      `登录态已失效（HTTP ${probe.status}）。请重新执行：node bin/wbcs.js login`
    );
  }

  let ok = 0;
  let fail = 0;
  const t0 = Date.now();

  for (let i = 0; i < targets.length; i++) {
    const s = targets[i];
    const label = `[${i + 1}/${targets.length}]`;
    const short = s.title.length > 18 ? s.title.slice(0, 18) + "…" : s.title;
    process.stdout.write(`${label} ${short} `);
    const started = Date.now();

    try {
      const info = await fetchSessionInfo(page, s.id);
      const d = info.data || {};
      if (!d.token || !d.link) {
        fail++;
        const rec = {
          ...s,
          ok: false,
          error: `no_token_${info.status || info.error || "?"}`,
          messages: [],
          fetchedAt: Date.now(),
        };
        byId.set(s.id, rec);
        console.log(`跳过（${rec.error}）`);
        continue;
      }

      const link = String(d.link).replace(/^http:\/\//, "https://");
      const res = await loadSession(link, d.token, d.sessionId || s.id, {
        idleMs,
        maxMs,
        onWarn: (w) => process.env.WBCS_DEBUG && console.log(`  ⚠ ${w}`),
      });

      const parsed = parseEvents(res.events);
      const rec = {
        ...s,
        title: parsed.title || s.title,
        ok: true,
        stats: parsed.stats,
        messages: parsed.messages,
        elapsed: Math.round((Date.now() - started) / 1000),
        fetchedAt: Date.now(),
      };
      byId.set(s.id, rec);
      ok++;
      console.log(
        `${parsed.stats.total} 条 / ${parsed.stats.tool} 工具 · ${rec.elapsed}s · ${res.reason}`
      );
    } catch (e) {
      fail++;
      byId.set(s.id, {
        ...s,
        ok: false,
        error: String((e && e.message) || e).slice(0, 300),
        messages: [],
        fetchedAt: Date.now(),
      });
      console.log(`失败：${(e && e.message) || e}`);
    }

    // 每 3 条落盘一次
    if (i % 3 === 0) writeStore({ generatedAt: Date.now(), items: [...byId.values()] });
  }

  // 合并：以本地列表顺序为准，保留历史里但本次没抓的
  const merged = list.map((s) => byId.get(s.id) || { ...s, ok: false, messages: [] });
  for (const [id, it] of byId) if (!merged.find((m) => m.id === id)) merged.push(it);

  writeStore({ generatedAt: Date.now(), items: merged });
  await ctx.close();

  const totalMsgs = merged.filter((m) => m.ok).reduce((a, b) => a + (b.stats?.total || 0), 0);
  console.log(
    `\n完成：成功 ${ok} 条，失败 ${fail} 条，累计 ${totalMsgs} 条消息，耗时 ${Math.round(
      (Date.now() - t0) / 1000
    )}s`
  );
  console.log(`结果：${SESSIONS_JSON}`);
  console.log(`下一步：node bin/wbcs.js build && node bin/wbcs.js deploy`);
  return { generatedAt: Date.now(), items: merged };
}

module.exports = { fetchAll, fetchSessionInfo, readStore, writeStore, WEB_ORIGIN };
