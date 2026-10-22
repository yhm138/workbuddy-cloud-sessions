"use strict";

/**
 * 读取 WorkBuddy 本地 SQLite：只拿「哪些云端会话存在」这类元数据。
 * 正文不在这里（正文只存在于云端，靠 ACP 回放拿）。
 */

const fs = require("fs");
const path = require("path");
const { DB_PATH, ORIGIN_LABEL } = require("./config");

let DatabaseSync = null;
try {
  // Node 22+ 内置 sqlite
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const QUERY = `
  select id,
         coalesce(nullif(custom_title, ''), title) as title,
         conversation_origin,
         coalesce(last_activity_at, created_at) as ts,
         created_at,
         coalesce(status, '') as status
  from sessions
  where transport = 'cloud'
    and (deleted_at is null or deleted_at = -1)
    and coalesce(status, '') != 'archived'
  order by ts desc
`;

function openDb(dbPath = DB_PATH) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `找不到 WorkBuddy 数据库：${dbPath}\n` +
        `请先在桌面端登录一次（或设置 WBCS_DB 指向 workbuddy.db）。`
    );
  }
  if (!DatabaseSync) {
    throw new Error(
      `当前 Node ${process.version} 没有内置 node:sqlite。\n` +
        `请升级到 Node 22+，或用 --db 手动提供 sessions.json。`
    );
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** 返回云端会话列表（按最近活跃倒序） */
function listCloudSessions(dbPath = DB_PATH) {
  const db = openDb(dbPath);
  let rows = [];
  try {
    rows = db.prepare(QUERY).all();
  } finally {
    db.close();
  }
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title || "(无标题)").trim() || "(无标题)",
    origin: String(r.conversation_origin || "unknown"),
    originLabel: ORIGIN_LABEL[String(r.conversation_origin)] || "未知来源",
    ts: Number(r.ts || 0),
    created: Number(r.created_at || 0),
    status: String(r.status || ""),
  }));
}

/**
 * 判断 DB 是否可用；不可用时返回原因字符串。
 * 用于让 fetch 有个更好的降级路径（比如只有 sessions.json 的 CI 环境）。
 */
function dbStatus(dbPath = DB_PATH) {
  if (!fs.existsSync(dbPath)) return `数据库不存在：${dbPath}`;
  if (!DatabaseSync) return `Node ${process.version} 无 node:sqlite`;
  try {
    const db = openDb(dbPath);
    const n = db.prepare("select count(*) as n from sessions").get();
    db.close();
    return null;
  } catch (e) {
    return `读取失败：${e.message}`;
  }
}

module.exports = { listCloudSessions, dbStatus, DB_PATH: path.resolve(DB_PATH) };
