// 2B(前台)的工具：通过 discord_bridge 的本地接口操作 Claude Code 会话。
// 由 discord_bridge.mjs 用 `pi -p --no-extensions --no-builtin-tools -e pi_2b_tools.ts` 加载，
// 所以 2B 只有这几个工具，不能直接读写文件或执行命令；动手的活一律交给 Claude Code 会话。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { Type } from "typebox";

const API = process.env.DISCORD_BRIDGE_API || "http://127.0.0.1:8793";
const TOKEN_FILE = process.env.DISCORD_BRIDGE_TOKEN_FILE || "";

async function call(method: string, route: string, body?: unknown) {
  const token = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `桥接接口返回 HTTP ${res.status}`);
  return json;
}

const asResult = (json: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(json, null, 2) }], details: json });

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "cc_status",
    label: "Claude Code 会话状态",
    description:
      "查看当前绑定在 Discord 帖子上的 Claude Code 会话：标题、帖子链接、是否在工作、最近在做什么、上一轮回复的开头。不传 thread_id 就返回全部。",
    parameters: Type.Object({
      thread_id: Type.Optional(Type.String({ description: "只看某一个会话的帖子 ID" })),
    }),
    execute: async (_id, params) => asResult(await call("GET", `/sessions${params.thread_id ? `?thread_id=${encodeURIComponent(params.thread_id)}` : ""}`)),
  });

  pi.registerTool({
    name: "cc_open",
    label: "开 Claude Code 会话",
    description:
      "开一个新的 Claude Code 会话(论坛里新建一个帖子，电脑上开一个终端)。如果给了 task，会把任务作为第一条消息交给它，进度和结果会出现在那个帖子里。返回帖子链接。",
    parameters: Type.Object({
      title: Type.String({ description: "会话标题，简短概括要做的事" }),
      task: Type.Optional(Type.String({ description: "要交给 Claude Code 的完整任务描述，写清楚目标和要求" })),
      cwd: Type.Optional(Type.String({ description: "工作目录，默认用户主目录 C:\\Users\\13116" })),
    }),
    execute: async (_id, params) => asResult(await call("POST", "/cc/open", params)),
  });

  pi.registerTool({
    name: "cc_send",
    label: "给 Claude Code 会话发消息",
    description: "往一个已经存在的 Claude Code 会话帖子里发一条消息(交代新任务、补充要求、回答它的问题)。Claude 正在忙的话会排队。",
    parameters: Type.Object({
      thread_id: Type.String({ description: "会话帖子 ID，从 cc_status 或 cc_open 的结果里拿" }),
      text: Type.String({ description: "要发给 Claude 的内容" }),
    }),
    execute: async (_id, params) => asResult(await call("POST", "/cc/send", params)),
  });

  pi.registerTool({
    name: "cc_list_history",
    label: "列出以前的 Claude 会话",
    description:
      "列出电脑上最近的 Claude Code 会话(包括没绑定到 Discord 的)：session_id、标题、最后一句、目录、多久前更新、是否已绑定、是否最近还在更新。用来找要接回来的旧会话。",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "最多返回几个，默认 10" })),
    }),
    execute: async (_id, params) => asResult(await call("GET", `/history?limit=${params.limit ?? 10}`)),
  });

  pi.registerTool({
    name: "cc_resume",
    label: "接回以前的 Claude 会话",
    description:
      "把一个以前的 Claude Code 会话接到新的 Discord 帖子里，上下文保留。recently_active 为 true 的会话可能正开在别的终端里，必须先问用户确认，确认后才传 force=true。",
    parameters: Type.Object({
      session_id: Type.String({ description: "cc_list_history 返回的 session_id" }),
      force: Type.Optional(Type.Boolean({ description: "用户确认过后才设为 true" })),
    }),
    execute: async (_id, params) => asResult(await call("POST", "/cc/resume", params)),
  });

  pi.registerTool({
    name: "cc_stop",
    label: "中止 Claude 当前任务",
    description: "中止某个会话里 Claude 正在做的任务(相当于按 Esc)。只在用户明确要求停下时用。",
    parameters: Type.Object({ thread_id: Type.String({ description: "会话帖子 ID" }) }),
    execute: async (_id, params) => asResult(await call("POST", "/cc/stop", params)),
  });

  pi.registerTool({
    name: "cc_end",
    label: "结束 Claude 会话",
    description: "结束一个会话并关掉它的终端(对话记录保留，之后还能接回来)。只在用户明确要求结束时用。",
    parameters: Type.Object({ thread_id: Type.String({ description: "会话帖子 ID" }) }),
    execute: async (_id, params) => asResult(await call("POST", "/cc/end", params)),
  });
}
