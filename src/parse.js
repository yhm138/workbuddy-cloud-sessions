"use strict";

/**
 * ACP session/update 事件 → 统一的扁平面条结构。
 *
 * 事件类型（sessionUpdate 字段）：
 *   user_message_chunk     用户消息（可能被切成多个 chunk，按 messageId 合并）
 *   agent_message_chunk    助手回复（同上）
 *   agent_thought_chunk    思考过程
 *   tool_call              工具调用开始（rawInput 是入参）
 *   tool_call_update       工具调用状态/输出更新
 *   session_info_update    会话标题
 *   _codebuddy.ai/artifact 产物快照，噪音极大（单会话可上万条），丢弃
 *
 * 输出消息字段：{ r: role, t: text, k: kind, n: name, s: status, i: input, o: output }
 */

const LIMITS = {
  text: 24000,
  input: 4000,
  output: 8000,
};

function textOfContent(c) {
  if (!c) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(textOfContent).filter(Boolean).join("\n");
  if (typeof c === "object") {
    if (typeof c.text === "string") return c.text;
    if (c.content) return textOfContent(c.content);
    if (c.type === "image") return "[图片]";
    if (c.type === "resource" && c.resource) return textOfContent(c.resource);
    return "";
  }
  return "";
}

function clip(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n) + "\n…(已截断)" : s;
}

/**
 * @param {object[]} events
 * @returns {{messages:object[], title:string|null, stats:object}}
 */
function parseEvents(events) {
  const messages = [];
  const tools = new Map();
  let title = null;
  let lastText = null;
  const seen = { user: 0, assistant: 0, thought: 0, tool: 0 };

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.method && ev.method !== "session/update") continue;

    const params = ev.params || {};
    const up = params.update;
    if (!up) continue;

    const type = up.sessionUpdate;

    if (
      type === "user_message_chunk" ||
      type === "agent_message_chunk" ||
      type === "agent_thought_chunk"
    ) {
      const role =
        type === "user_message_chunk"
          ? "user"
          : type === "agent_thought_chunk"
          ? "thought"
          : "assistant";
      const text = textOfContent(up.content);
      if (!text) continue;
      const mid = up.messageId || up.uuid || "";
      // 同一 messageId 的连续 chunk 合并成一条
      if (lastText && lastText.r === role && mid && lastText.mid === mid) {
        lastText.t += text;
      } else {
        lastText = { r: role, t: text, mid, k: "", n: "", s: "", i: "", o: "" };
        messages.push(lastText);
        seen[role] = (seen[role] || 0) + 1;
      }
      continue;
    }

    if (type === "tool_call") {
      const id = up.toolCallId || up.uuid || `tool-${messages.length}`;
      const item = {
        r: "tool",
        t: "",
        k: up.kind || "tool",
        n: up.title || "",
        s: up.status || "",
        i: clip(
          up.rawInput ? JSON.stringify(up.rawInput, null, 1) : textOfContent(up.content),
          LIMITS.input
        ),
        o: "",
      };
      tools.set(id, item);
      messages.push(item);
      seen.tool++;
      lastText = null;
      continue;
    }

    if (type === "tool_call_update") {
      const item = tools.get(up.toolCallId);
      if (!item) continue;
      if (up.status) item.s = up.status;
      if (up.title) item.n = up.title;
      const out = textOfContent(up.content) || (up.rawOutput ? JSON.stringify(up.rawOutput) : "");
      if (out) item.o = clip(out, LIMITS.output);
      continue;
    }

    if (type === "session_info_update") {
      if (up.title) title = up.title;
      continue;
    }
  }

  // 收敛过长的正文，避免单条塞爆分片
  for (const m of messages) {
    if (m.t && m.t.length > LIMITS.text) m.t = clip(m.t, LIMITS.text);
  }

  return {
    messages,
    title,
    stats: {
      total: messages.length,
      user: seen.user,
      assistant: seen.assistant,
      thought: seen.thought,
      tool: seen.tool,
    },
  };
}

module.exports = { parseEvents, textOfContent, LIMITS };
