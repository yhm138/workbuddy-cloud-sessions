"use strict";

/**
 * ACP 客户端（Agent Client Protocol over HTTP）。
 *
 * 这份是**唯一实现**：CLI（src/acp.js）与扩展内的 Node service（server/index.cjs）
 * 都 require 它。放在 server/ 是因为扩展部署时只带 server/ + ui/，不带 src/。
 *
 * 云端会话的正文不走 REST，流程是：
 *   1. GET  {link}                    accept: text/event-stream  → 建 SSE 长连接
 *                                     ← 响应头 acp-connection-id（后续 POST 必须带）
 *   2. POST {link}  initialize        JSON-RPC 2.0
 *   3. POST {link}  session/load      历史消息从 SSE 以 session/update 事件回放
 *
 * 关键坑：
 *   - 不带 acp-connection-id → 404 "connection not found"
 *   - SSE 还没 ready 就 POST → 同样 404
 *   - 历史是「回放」，没有明确的结束标记，只能靠空闲超时判定结束
 */

const http = require("http");
const https = require("https");
const crypto = require("crypto");

/** link 可能是 http（网关内部地址）也可能是 https；本地模拟网关用 http */
function clientFor(u) {
  return u.protocol === "http:" ? http : https;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const ORIGIN = "https://www.workbuddy.cn";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 连接池：一次回放要连 3 次（SSE + initialize + session/load），
 * 没有 keep-alive 每次都是全新 TLS 握手，实测白白多花 300~700ms。
 * 网关对并发敏感，所以 maxSockets 压得比较低。
 */
const agents = {
  "http:": new http.Agent({ keepAlive: true, maxSockets: 6, keepAliveMsecs: 15000 }),
  "https:": new https.Agent({ keepAlive: true, maxSockets: 6, keepAliveMsecs: 15000 }),
};

function agentFor(u) {
  return agents[u.protocol] || agents["https:"];
}

/** 预热：提前把到网关的 TLS 连接建好，挂进 keep-alive 池，第一次点会话就少一次握手 */
function warmup(origin) {
  try {
    const u = new URL(origin);
    const req = clientFor(u).request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: "/",
        method: "HEAD",
        agent: agentFor(u),
        timeout: 4000,
      },
      (res) => res.resume()
    );
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.end();
    return true;
  } catch {
    return false;
  }
}

function baseHeaders(token, extra) {
  return {
    accept: "application/json, text/event-stream",
    "accept-encoding": "identity",
    authorization: `Bearer ${token}`,
    origin: ORIGIN,
    referer: `${ORIGIN}/`,
    "x-teams-mode": "true",
    "user-agent": UA,
    ...extra,
  };
}

/** POST 一个 JSON-RPC 请求到 ACP 端点 */
function rpc(link, token, connId, payload, timeout = 40000) {
  return new Promise((resolve) => {
    const u = new URL(link);
    const body = JSON.stringify(payload);
    const req = clientFor(u).request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + (u.search || ""),
        method: "POST",
        agent: agentFor(u),
        headers: baseHeaders(token, {
          "content-type": "application/json",
          "acp-connection-id": connId,
          "content-length": Buffer.byteLength(body),
        }),
        timeout,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, error: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

/**
 * 回放一条会话的全部历史事件。
 * @param {string} link      /session 接口返回的消息服务地址
 * @param {string} token     沙箱网关 JWT
 * @param {string} sessionId
 * @param {{idleMs?:number, ackIdleMs?:number, maxMs?:number, onEvent?:Function, onWarn?:Function}} opts
 * @returns {Promise<{events:object[], reason:string, connId:string|null, timings:object}>}
 */
function loadSession(link, token, sessionId, opts = {}) {
  // 收尾窗口：历史是「回放」，没有结束标记，只能靠静默判定。
  // v1.9 之前写死 4000ms，一条会话哪怕 200ms 就回放完了也要干等 4 秒 —— 这是「等待略长」的主因。
  const replayIdle = opts.idleMs || 1400;
  // session/load 已有回执后，尾部一般只剩残留帧，可以更早收
  const ackIdle = opts.ackIdleMs || 700;
  const maxMs = opts.maxMs || 120000;
  const t0 = Date.now();
  const events = [];
  let buf = "";
  let closed = false;
  let connId = null;
  let loadAcked = false;
  const timings = { connect: 0, firstFrame: 0, init: 0, load: 0, replay: 0, total: 0 };

  return new Promise((resolve) => {
    const u = new URL(link);
    let idleTimer = null;
    let hardTimer = null;

    const finish = (reason) => {
      if (closed) return;
      closed = true;
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      try {
        sse && sse.destroy();
      } catch {}
      timings.total = Date.now() - t0;
      resolve({ events, reason, connId, timings });
    };

    /** 静默多久算回放结束：拿到 load 回执后收紧，剩下的都是尾部帧 */
    const idleFor = () => (loadAcked && events.length ? ackIdle : replayIdle);

    const bump = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish("idle"), idleFor());
    };

    let readyResolve;
    const ready = new Promise((r) => (readyResolve = r));
    let frameResolve;
    const firstFrame = new Promise((r) => (frameResolve = r));
    let frameSeen = false;

    const sse = clientFor(u).request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + (u.search || ""),
        method: "GET",
        agent: agentFor(u),
        headers: baseHeaders(token, { accept: "text/event-stream" }),
      },
      (res) => {
        if (res.statusCode !== 200) {
          readyResolve(false);
          finish(`sse-${res.statusCode}`);
          return;
        }
        // 关键：连接 id 由服务端在响应头下发
        connId = res.headers["acp-connection-id"] || crypto.randomUUID();
        timings.connect = Date.now() - t0;
        readyResolve(true);
        res.setEncoding("utf8");
        bump();
        res.on("data", (chunk) => {
          // 首帧一到就能发 initialize，不必像老版本那样 sleep(600) 干等
          if (!frameSeen) {
            frameSeen = true;
            timings.firstFrame = Date.now() - t0;
            frameResolve(true);
          }
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            let line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            if (line.startsWith("data:")) line = line.slice(5).trim();
            if (!line || line === "[DONE]") continue;
            try {
              const ev = JSON.parse(line);
              events.push(ev);
              timings.replay = Date.now() - t0;
              if (opts.onEvent) opts.onEvent(ev);
              bump();
            } catch {
              /* 心跳 / 非 JSON 帧，忽略 */
            }
          }
        });
        res.on("end", () => finish("sse-end"));
        res.on("error", () => finish("sse-err"));
      }
    );

    sse.on("error", () => {
      readyResolve(false);
      finish("sse-request-error");
    });
    sse.end();

    hardTimer = setTimeout(() => finish("max"), maxMs);

    (async () => {
      const ok = await Promise.race([ready, sleep(10000).then(() => false)]);
      if (!ok) return;
      // 首帧握手：正常情况下 0~80ms；服务端抽风就最多等 700ms，再不行照旧往下走
      await Promise.race([firstFrame, sleep(700)]);

      const r0 = await rpc(link, token, connId, {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            _meta: {
              "codebuddy.ai": {
                question: true,
                terminalOutput: true,
                terminalOutputChunk: true,
              },
            },
          },
        },
      });
      timings.init = Date.now() - t0;
      if (r0.status !== 200 && r0.status !== 202) {
        opts.onWarn && opts.onWarn(`initialize → ${r0.status} ${(r0.body || r0.error || "").slice(0, 160)}`);
      }

      const r1 = await rpc(link, token, connId, {
        jsonrpc: "2.0",
        id: 1,
        method: "session/load",
        params: { sessionId, cwd: "/workspace", mcpServers: [] },
      });
      timings.load = Date.now() - t0;
      if (r1.status !== 200 && r1.status !== 202) {
        opts.onWarn && opts.onWarn(`session/load → ${r1.status} ${(r1.body || r1.error || "").slice(0, 200)}`);
      } else {
        loadAcked = true;
        bump(); // 换成更短的收尾窗口；后面还有帧就继续顺延
      }
    })();
  });
}

module.exports = { loadSession, rpc, warmup };
