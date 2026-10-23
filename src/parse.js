"use strict";

/**
 * ACP session/update 解析 —— 实现已移到 server/parse.cjs。
 * 原因同 src/acp.js：扩展部署时只带 server/，实现必须放在能被部署的那一侧。
 */

module.exports = require("../server/parse.cjs");
