"use strict";

/**
 * ACP 客户端 —— 实现已移到 server/acp.cjs。
 *
 * 扩展内的 fork service 必须自带这份代码（部署时不会带 src/），
 * 所以把实现放在 server/ 下，CLI 这边只做转发，避免两份逻辑跑偏。
 */

module.exports = require("../server/acp.cjs");
