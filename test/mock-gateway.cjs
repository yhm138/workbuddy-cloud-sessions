"use strict";

/**
 * 假网关：同时扮演两个角色，给 server/ 与面板的自测用。
 *   GET  /console/as/conversations/<id>/session  → {link, token, sessionId}
 *   GET  /acp                                    → SSE，回放假历史
 *   POST /acp                                    → JSON-RPC，返回 {}
 */

const http = require("http");

const SESSION_ID = "test-session-1";

const EVENTS = [
  { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "session_info_update", title: "假会话标题" } } },
  { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "user_message_chunk", messageId: "u1", content: { text: "你好" } } } },
  { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "user_message_chunk", messageId: "u1", content: { text: "，在吗" } } } },
  { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", messageId: "t1", content: { text: "想一下" } } } },
  { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { text: "在的" } } } },
  { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { text: "，你说" } } } },
  { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "c1", title: "Read", kind: "read", status: "pending", rawInput: { path: "a.txt" } } } },
  { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: { text: "ok" } } } },
  // 噪音：必须被丢掉
  { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "_codebuddy.ai/artifact", data: { big: "x".repeat(1000) } } } },
];

function startGateway() {
  let loads = 0;
  let port = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/console/as/conversations/")) {
      const id = decodeURIComponent(url.pathname.split("/")[4] || "");
      /* 真实网关对「云端有正文的会话」都会给票据，不区分来源；
         假网关照此实现，这样小程序来源的会话也能测到详情页。
         只有显式的 `nope` 用来测「云端没有这条」的失败路径。 */
      if (!id || id === "nope") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 404, msg: "not found", data: null }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          code: 0,
          msg: "OK",
          data: {
            link: `http://127.0.0.1:${port}/acp?session=${id}`,
            token: "fake-token",
            sessionId: id,
          },
        })
      );
      return;
    }

    if (url.pathname === "/acp" && req.method === "GET") {
      loads++;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "acp-connection-id": "conn-" + loads,
        connection: "keep-alive",
      });
      setTimeout(() => {
        for (const ev of EVENTS) res.write("data: " + JSON.stringify(ev) + "\n\n");
      }, 120);
      const keep = setInterval(() => res.write(": ping\n\n"), 1000);
      req.on("close", () => clearInterval(keep));
      return;
    }

    if (url.pathname === "/acp" && req.method === "POST") {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 0, result: {} }));
      });
      return;
    }

    res.writeHead(404).end("no");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve({ server, port: () => port, loads: () => loads });
    });
  });
}

/** 模拟宿主的 wb.http.get：把 workbuddy.cn 的请求指到假网关 */
function makeWb(port) {
  return {
    http: {
      get(url) {
        const target = String(url).replace(/^https:\/\/www\.workbuddy\.cn/, `http://127.0.0.1:${port}`);
        return new Promise((resolve, reject) => {
          http
            .get(target, { headers: { accept: "application/json" } }, (res) => {
              let s = "";
              res.setEncoding("utf8");
              res.on("data", (d) => (s += d));
              res.on("end", () => {
                if (res.statusCode !== 200) {
                  const e = new Error("HTTP " + res.statusCode);
                  e.status = res.statusCode;
                  reject(e);
                  return;
                }
                try {
                  resolve(JSON.parse(s));
                } catch (e) {
                  reject(e);
                }
              });
            })
            .on("error", reject);
        });
      },
    },
  };
}

module.exports = { startGateway, makeWb, SESSION_ID, EVENTS };
