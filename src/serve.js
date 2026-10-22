"use strict";

/**
 * 本地静态预览：不装扩展也能看全部会话（浏览器里直接打开 http://127.0.0.1:8787/）。
 * 只监听回环地址，不对外暴露。
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { UI_DIR } = require("./config");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".ico": "image/x-icon",
};

function serve(opts = {}) {
  const port = Number(opts.port || process.env.PORT || 8787);
  const root = path.resolve(opts.root || UI_DIR);

  if (!fs.existsSync(path.join(root, "index.html"))) {
    throw new Error(`没有找到 ${path.join(root, "index.html")}，先跑 build`);
  }

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    let file = path.join(root, urlPath === "/" ? "index.html" : urlPath);

    // 防目录穿越
    if (!file.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      file = path.join(file, "index.html");
    }
    if (!fs.existsSync(file)) {
      // SPA 兜底
      file = path.join(root, "index.html");
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  });

  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`预览地址：${url}`);
    console.log("（Ctrl+C 停止）");
    if (opts.open !== false) {
      const { exec } = require("child_process");
      const cmd =
        process.platform === "win32"
          ? `start "" "${url}"`
          : process.platform === "darwin"
          ? `open "${url}"`
          : `xdg-open "${url}"`;
      exec(cmd, () => {});
    }
  });

  return server;
}

module.exports = { serve };
