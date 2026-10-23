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
 * @param {{idleMs?:number, maxMs?:number, onEvent?:Function}} opts
 * @returns {Promise<{events:object[], reason:string, connId:string|null}>}
 */
function loadSession(link, token, sessionId, opts = {}) {
  const idleMs = opts.idleMs || 4000;
  const maxMs = opts.maxMs || 120000;
  const events = [];
  let buf = "";
  let closed = false;
  let connId = null;

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
      resolve({ events, reason, connId });
    };

    const bump = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish("idle"), idleMs);
    };

    let readyResolve;
    const ready = new Promise((r) => (readyResolve = r));

    const sse = clientFor(u).request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + (u.search || ""),
        method: "GET",
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
        readyResolve(true);
        res.setEncoding("utf8");
        bump();
        res.on("data", (chunk) => {
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
      await sleep(600); // 等握手帧落地

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
      if (r0.status !== 200 && r0.status !== 202) {
        opts.onWarn && opts.onWarn(`initialize → ${r0.status} ${(r0.body || r0.error || "").slice(0, 160)}`);
      }
      await sleep(300);

      const r1 = await rpc(link, token, connId, {
        jsonrpc: "2.0",
        id: 1,
        method: "session/load",
        params: { sessionId, cwd: "/workspace", mcpServers: [] },
      });
      if (r1.status !== 200 && r1.status !== 202) {
        opts.onWarn && opts.onWarn(`session/load → ${r1.status} ${(r1.body || r1.error || "").slice(0, 200)}`);
      } else {
        bump();
      }
    })();
  });
}

module.exports = { loadSession, rpc };
