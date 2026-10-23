"use strict";

/**
 * 云端会话 · 扩展内 Node service（宿主 fork 的子进程）。
 *
 * 为什么需要它：
 *   面板是 iframe，浏览器里拉云端正文有两条死路 ——
 *   ① `wb:conversations:*` 读的是本机 daemon 历史，cloud 会话压根没有本地 runtime；
 *   ② 面板里 `fetch()` 直连 ACP 网关会被 CORS 挡死（网关不回
 *      access-control-allow-origin，也不 expose acp-connection-id）。
 *
 *   这个进程是真正的 Node：用 `https` 建 SSE 没有 CORS，用 `wb.http.get()`
 *   借宿主的登录态换 `{link, token}` —— 于是**不需要扫码**，也不依赖浏览器 profile。
 *
 * 宿主约定（见 docs/PROTOCOL.md 6.9）：
 *   - extension.json 声明 `"service": { "entry": "./server/index.cjs", "process": "fork" }`
 *   - 本文件导出 `activate(wb)`，返回 `{ methods, dispose }`
 *   - methods 里的方法名不能带 `/`、不能以 `wb:internal:` 开头
 *   - 面板侧走 `wb:extensions:$resolveLocalRpc` 拿票据，
 *     再用 `wb:extensions:$invokeLocalRpcFallback` 调用
 */

const { loadSession } = require("./acp.cjs");
const { parseEvents } = require("./parse.cjs");

/** 与 package.json 保持一致（CI 会比对；部署目录里没有 package.json，只能写死） */
const VERSION = "1.9.1";
const WEB = "https://www.workbuddy.cn";

/** 正文缓存：重开同一条会话不再重新回放 */
const CACHE_TTL = 3 * 60 * 1000;
const CACHE_MAX = 24;
/** 同时回放的会话数：网关对并发很敏感，2 是实测比较稳的值 */
const MAX_CONCURRENT = 2;
/** 单条会话硬超时 / 空闲收尾 */
const DEFAULT_MAX_MS = 60000;
const DEFAULT_IDLE_MS = 4000;
/** 一次返回给 iframe 的最大消息数，避免把 IPC 塞爆 */
const MAX_MESSAGES = 6000;

const cache = new Map(); // id -> { shard, at }
const inflight = new Map(); // id -> Promise
const recent = []; // 诊断用环形日志
const calls = []; // 最近几次方法调用的参数形状（排查参数约定用）

let active = 0;
const waiting = [];
let disposed = false;

function record(method, args) {
  calls.push({ at: Date.now(), method, shape: shapeOf(args) });
  if (calls.length > 12) calls.shift();
}

function note(line) {
  const s = `${new Date().toISOString().slice(11, 19)} ${line}`;
  recent.push(s);
  if (recent.length > 40) recent.shift();
  try {
    console.log(`[cloud-sessions] ${line}`);
  } catch {}
}

/** 并发闸门 */
function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          const next = waiting.shift();
          if (next) next();
        });
    };
    if (active < MAX_CONCURRENT) run();
    else waiting.push(run);
  });
}

/** {code,msg,data} / axios 双层 / 裸 body 统一拆一层 */
function unwrap(v) {
  let r = v;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch {
      return null;
    }
  }
  if (r && typeof r === "object") {
    if (r.data !== undefined && (r.code !== undefined || r.msg !== undefined || r.message !== undefined)) {
      r = r.data;
    } else if (r.data && typeof r.data === "object" && r.data.data !== undefined && r.data.code !== undefined) {
      r = r.data;
    }
  }
  return r;
}

function errCode(e) {
  return (e && (e.code || e.name)) || "ERROR";
}

/**
 * 换单条会话的 ACP 票据。
 * `wb.http.get` 会带宿主的 cookie / bearer，返回体就是网页版那个接口。
 */
async function fetchTicket(wb, id) {
  const url = `${WEB}/console/as/conversations/${encodeURIComponent(id)}/session`;
  const opts = { headers: { accept: "application/json" } };
  let resp;
  if (wb.http && typeof wb.http.get === "function") {
    try {
      resp = await wb.http.get(url, opts);
    } catch (e) {
      // 某些宿主版本不给第二参数，退一步再试一次
      if (!/INVALID|argument|param/i.test(String(e && e.message))) throw e;
      resp = await wb.http.get(url);
    }
  } else if (typeof wb.invoke === "function") {
    resp = await wb.invoke("wb:http:get", url, opts);
  } else {
    const e = new Error("宿主没有提供 http 能力");
    e.code = "NO_HTTP";
    throw e;
  }
  const d = unwrap(resp) || {};
  if (!d.link || !d.token) {
    const e = new Error(`没拿到 link/token（${d.msg || d.message || "接口返回为空"}）`);
    e.code = "NO_TICKET";
    e.data = { keys: Object.keys(d).slice(0, 8) };
    throw e;
  }
  return {
    // 网关回的 link 常是 http，但对外只认 https。只升级 workbuddy.cn，
    // 别把本地模拟网关（http://127.0.0.1）也改成 https。
    link: String(d.link).replace(/^http:\/\/([^/]*workbuddy\.cn)/i, "https://$1"),
    token: String(d.token),
    sessionId: d.sessionId || id,
  };
}

/** parseEvents 的角色名 → 面板分片里的单字母（thought 必须单独给 h，别和 tool 撞） */
const ROLE = { user: "u", assistant: "a", thought: "h", tool: "t" };

function toShardMessages(messages) {
  return messages.map((m) => [
    ROLE[m.r] || "a",
    m.t || "",
    m.k || "",
    m.n || "",
    m.s || "",
    m.i || "",
    m.o || "",
  ]);
}

async function fetchShard(wb, id, opts) {
  const t0 = Date.now();
  const ticket = await fetchTicket(wb, id);
  const res = await loadSession(ticket.link, ticket.token, ticket.sessionId, {
    idleMs: opts.idleMs || DEFAULT_IDLE_MS,
    maxMs: opts.maxMs || DEFAULT_MAX_MS,
    onWarn: (w) => note(`warn ${id} ${w}`),
  });
  const parsed = parseEvents(res.events);
  let messages = toShardMessages(parsed.messages);
  let truncated = false;
  if (messages.length > MAX_MESSAGES) {
    messages = messages.slice(-MAX_MESSAGES);
    truncated = true;
  }
  const shard = {
    id,
    ok: true,
    title: parsed.title || null,
    stats: parsed.stats,
    messages,
    truncated,
    events: res.events.length,
    reason: res.reason,
    fetchedAt: Date.now(),
    source: "acp",
  };
  note(`ok ${id} ${messages.length} msgs / ${res.events.length} ev · ${Math.round((Date.now() - t0) / 1000)}s · ${res.reason}`);
  return { shard, elapsed: Date.now() - t0 };
}

function remember(id, shard) {
  cache.delete(id);
  cache.set(id, { shard, at: Date.now() });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/* 宿主调用 service 方法的真实形态是 `fn(context, payload)`：
 *   main   : invokeExtension(method, ...args) → transport.invoke(method, { callerId }, ...args)
 *   fork   : transport.handle(channel, (...args) => fn(...args)) → args = [{ callerId }, payload]
 * 关键：没有 caller 时 `callerId` 是 **undefined**，所以判「像不像 context」只能用
 * `in`，不能用 `!== undefined` —— 用后者会把 `{callerId: undefined}` 当成业务载荷，
 * 于是 `fetchBody` 收到的是 context、`p.id` 为空，报「缺少 id」。这个坑踩过一次。 */
const CTX_KEYS = [
  "callerId",
  "transport",
  "endpoint",
  "invocation",
  "subject",
  "accountGeneration",
  "instanceGeneration",
  "runtimeGeneration",
  "connectionEpoch",
  "signal",
];

function looksLikeContext(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  for (const k of CTX_KEYS) if (k in v) return true;
  return false;
}

/** 从调用参数里挑出业务载荷：兼容 (payload) / (payload, ctx) / (ctx, payload) */
function pickParams(...args) {
  const all = args.filter((v) => v !== undefined);
  if (!all.length) return undefined;
  if (all.length === 1) return all[0];
  const rest = all.filter((v) => !looksLikeContext(v));
  if (rest.length) return rest[rest.length - 1];
  return all[all.length - 1];
}

/** 兜底：参数形状再怎么变，19 位会话 id 总在某个角落 */
function findSessionId(args) {
  const seen = new Set();
  const isId = (v) => typeof v === "string" && /^\d{15,}$/.test(v);
  function walk(v, depth) {
    if (depth > 4 || v == null || typeof v !== "object" && typeof v !== "string") return "";
    if (typeof v === "string") return isId(v) ? v : "";
    if (seen.has(v)) return "";
    seen.add(v);
    for (const k of ["id", "sessionId", "session_id", "conversationId", "conversation_id"]) {
      if (isId(v[k])) return v[k];
    }
    for (const k of Object.keys(v)) {
      const r = walk(v[k], depth + 1);
      if (r) return r;
    }
    return "";
  }
  for (const a of args) {
    const r = walk(a, 0);
    if (r) return r;
  }
  return "";
}

/** 诊断用：把参数形状压成一行，出错时带回给面板 */
function shapeOf(args) {  const brief = (v, d) => {
    if (v === undefined) return "undefined";
    if (v === null) return "null";
    if (typeof v === "string") return "str[" + v.length + "]";
    if (typeof v !== "object") return typeof v + ":" + String(v);
    if (Array.isArray(v)) return "arr[" + v.length + "]";
    if (d > 0) return "obj{" + Object.keys(v).slice(0, 6).join(",") + "}";
    const parts = Object.keys(v).slice(0, 8).map((k) => k + "=" + brief(v[k], 1));
    return "{" + parts.join(" ") + "}";
  };
  try {
    return "(" + args.map((a) => brief(a, 0)).join(", ") + ")";
  } catch (e) {
    return "(unserializable)";
  }
}

/** 先按业务载荷取 id，取不到再从所有参数里兜底捞 19 位数字 */
function resolveId(p, args) {
  const direct = p && (p.id || p.sessionId || p.conversationId || p.session_id || p.conversation_id);
  if (direct) return String(direct);
  return findSessionId(args);
}

function activate(wb) {
  const startedAt = Date.now();
  note(`activate v${VERSION} pid=${process.pid} node=${process.versions.node}`);

  const methods = {
    /** 健康检查：面板用它判断 service 是否真的在跑 */
    ping(...args) {
      record("ping", args);
      return {
        ok: true,
        version: VERSION,
        pid: process.pid,
        node: process.versions.node,
        startedAt,
        uptime: Date.now() - startedAt,
        http: Boolean(wb && wb.http && typeof wb.http.get === "function"),
        cache: cache.size,
        active,
      };
    },

    /** 诊断：宿主能力、缓存、最近调用与失败原因 */
    status(...args) {
      record("status", args);
      return {
        ok: true,
        version: VERSION,
        pid: process.pid,
        startedAt,
        cache: [...cache.keys()],
        inflight: [...inflight.keys()],
        active,
        waiting: waiting.length,
        calls: calls.slice(-8),
        recent: recent.slice(-20),
      };
    },

    /** 只要票据（诊断用，token 打码） */
    async inspect(...args) {
      record("inspect", args);
      const p = pickParams(...args) || {};
      const id = resolveId(p, args);
      if (!id) return { ok: false, code: "BAD_ARGS", error: "缺少 id " + shapeOf(args) };
      try {
        const t = await fetchTicket(wb, id);
        return {
          ok: true,
          link: t.link.replace(/\/[^/]+\/?$/, "/…"),
          sessionId: t.sessionId,
          tokenLen: t.token.length,
        };
      } catch (e) {
        return { ok: false, code: errCode(e), error: String((e && e.message) || e), data: e && e.data };
      }
    },

    /**
     * 拉一条会话的完整正文。
     * @param {{id:string, force?:boolean, idleMs?:number, maxMs?:number}} payload
     * @returns {{ok:true, shard:object, cached:boolean, elapsed:number}|{ok:false, code:string, error:string}}
     */
    async fetchBody(...args) {
      record("fetchBody", args);
      const p = pickParams(...args) || {};
      const id = resolveId(p, args);
      if (!id) {
        note(`fetchBody 没有 id · args=${shapeOf(args)}`);
        return { ok: false, code: "BAD_ARGS", error: "缺少 id · 参数 " + shapeOf(args) };
      }
      // 参数里没捞到业务对象时（只从 id 兜底），force 得单独找
      const force = p.force || args.some((a) => a && typeof a === "object" && a.force === true);

      const hit = cache.get(id);
      if (!force && hit && Date.now() - hit.at < CACHE_TTL) {
        cache.delete(id);
        cache.set(id, hit);
        return { ok: true, shard: hit.shard, cached: true, elapsed: 0 };
      }

      const running = inflight.get(id);
      if (running) {
        const r = await running;
        return r;
      }

      const job = withSlot(async () => {
        try {
          const { shard, elapsed } = await fetchShard(wb, id, p);
          remember(id, shard);
          return { ok: true, shard, cached: false, elapsed };
        } catch (e) {
          const msg = String((e && e.message) || e);
          note(`fail ${id} ${errCode(e)} ${msg.slice(0, 160)}`);
          return {
            ok: false,
            id,
            code: errCode(e),
            error: msg.slice(0, 300),
            status: e && e.status,
          };
        }
      }).finally(() => inflight.delete(id));

      inflight.set(id, job);
      return job;
    },

    /** 清掉缓存（强制下一次走网络） */
    clear() {
      cache.clear();
      return { ok: true, cleared: true };
    },
  };

  return {
    methods,
    async dispose() {
      disposed = true;
      note("dispose");
      cache.clear();
    },
  };
}

module.exports = { activate, VERSION };
