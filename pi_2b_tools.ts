// 2B(前台)的额外工具，由 discord_bridge.mjs 用 `pi -p --no-extensions -e pi_2b_tools.ts` 加载：
//   cc_*   通过 discord_bridge 的本地接口调度 Claude Code 会话
//   tars_* 通过 tars-pilot(127.0.0.1:8765)在自动化浏览器里做网页操作
// pi 自带的 read/bash/edit/write 也开着，轻量的小活 2B 自己做。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { Type } from "typebox";

const API = process.env.DISCORD_BRIDGE_API || "http://127.0.0.1:8793";
const TOKEN_FILE = process.env.DISCORD_BRIDGE_TOKEN_FILE || "";
const TARS = "http://127.0.0.1:8765";
const TARS_START_SCRIPT = "C:\\Users\\13116\\ui-tars-local\\start-all.ps1";
const TARS_WAIT_MS = 4 * 60 * 1000; // 超过这个时间就先返回 run_id，之后用 tars_status 查

const BROWSER_PORTS: Record<string, number> = { chrome: 9222, edge: 9223 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// tars-pilot 只操作已经打开的、网址里带 cdp 关键字的标签页，自己不会新开标签页。
// 没有匹配的就先开一个；cdp 不能是 newtab/about:blank 这种占位值。
async function ensureTab(browser: string, cdp: string, url?: string) {
  const port = BROWSER_PORTS[browser];
  if (!port) return;
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  if (tabs.some((t: any) => t.type === "page" && String(t.url).includes(cdp))) return;
  const target = url || (cdp.includes(".") ? `https://${cdp}` : "");
  if (!target) throw new Error(`没有网址包含「${cdp}」的标签页，需要给 url 或者用网站域名做 cdp`);
  await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(target)}`, { method: "PUT" });
  await sleep(4000);
}


async function tars(method: string, route: string, body?: unknown) {
  const res = await fetch(`${TARS}${route}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `tars-pilot 返回 HTTP ${res.status}`);
  return json;
}

// tars-pilot 没在跑就用它自己的启动脚本拉起来(会开一个可见的 tars-pilot 窗口)
async function ensureTars() {
  try {
    await tars("GET", "/health");
    return;
  } catch {
    spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", TARS_START_SCRIPT], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    try {
      await tars("GET", "/health");
      return;
    } catch {}
  }
  throw new Error("tars-pilot 启动不起来，去电脑上看一下 tars-pilot 窗口");
}

function summarizeRun(run: any) {
  return {
    run_id: run.id,
    status: run.status,
    answer: run.result?.answer ?? null,
    failed_step: run.result?.failedStep ?? null,
    used_gpt: run.result?.usedGPT ?? null,
    error: run.error ?? null,
    recent_log: Array.isArray(run.log) ? run.log.slice(-8) : undefined,
  };
}

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
      task: Type.Optional(Type.String({ description: "要转给 Claude Code 的任务，基本照用户原话；缺上下文时补一两句事实背景，不要加你自己的流程或要求" })),
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
      text: Type.String({ description: "要发给 Claude 的内容，基本照用户原话" }),
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

  pi.registerTool({
    name: "tars_recipes",
    label: "列出网页操作模板",
    description: "列出 tars-pilot 已保存的网页操作模板(recipe)：名字、任务描述、需要的变量。能用模板就优先用模板，比让 GPT 现规划快且稳。",
    parameters: Type.Object({}),
    execute: async () => {
      await ensureTars();
      const list = await tars("GET", "/recipes");
      return asResult(list.map((r: any) => ({ name: r.name, task: r.task, vars: r.vars, cdp: r.cdp, browser: r.browser })));
    },
  });

  pi.registerTool({
    name: "tars_run",
    label: "网页操作",
    description:
      "让 tars-pilot 在自动化浏览器里操作网页(看截图定位按钮、点击、输入、读页面内容)，不占用用户的真实鼠标键盘。" +
      "二选一：recipe=模板名(配 vars) 或 task=自然语言任务描述。必须指定 cdp=要操作的标签页网址关键字。" +
      "小红书：browser='chrome', cdp='xiaohongshu.com'；其他所有网站：browser='edge'。" +
      "最多等 4 分钟，没做完会返回 run_id 和 status=running，之后用 tars_status 查。",
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "自然语言任务，写清楚要做什么、做到哪一步算完成、要读回什么信息" })),
      recipe: Type.Optional(Type.String({ description: "模板名，来自 tars_recipes" })),
      vars: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "模板/任务里的变量，如 {\"keyword\":\"电动滑板车\"}" })),
      cdp: Type.String({ description: "要操作的标签页网址关键字，填网站域名，如 xiaohongshu.com、bing.com、q.utoronto.ca；没有这样的标签页会自动打开一个" }),
      url: Type.Optional(Type.String({ description: "要打开的具体网址；不填就打开 https://<cdp>" })),
      browser: Type.Union([Type.Literal("chrome"), Type.Literal("edge")], { description: "chrome=小红书专用(9222)，edge=其他网站(9223)" }),
      save: Type.Optional(Type.String({ description: "成功后把这次操作存成模板的名字(以后可以直接用 recipe 回放)" })),
    }),
    execute: async (_id, params) => {
      if (!params.task && !params.recipe) throw new Error("task 和 recipe 至少给一个");
      await ensureTars();
      const { url, ...req } = params;
      await ensureTab(req.browser, req.cdp, url);
      const started = await tars("POST", "/runs", { ...req, wait: false });
      const runId = started.id;
      const deadline = Date.now() + TARS_WAIT_MS;
      // 进度和 Duo 匹配码由桥接里的 tars_watch 在「网页操作」频道播报(并 @ 用户)，这里只等结果
      while (Date.now() < deadline) {
        await sleep(3000);
        const run = await tars("GET", `/runs/${runId}`);
        if (!["queued", "running"].includes(run.status)) return asResult(summarizeRun(run));
      }
      return asResult({ run_id: runId, status: "running", note: "还没做完，稍后用 tars_status 查结果" });
    },
  });

  pi.registerTool({
    name: "tars_status",
    label: "查网页操作结果",
    description: "查一个 tars-pilot 任务的状态和结果(answer 里是读回来的信息)。",
    parameters: Type.Object({ run_id: Type.String({ description: "tars_run 返回的 run_id" }) }),
    execute: async (_id, params) => asResult(summarizeRun(await tars("GET", `/runs/${params.run_id}`))),
  });

  pi.registerTool({
    name: "tars_cancel",
    label: "取消网页操作",
    description: "取消一个排队中或执行中的 tars-pilot 任务。",
    parameters: Type.Object({ run_id: Type.String({ description: "tars_run 返回的 run_id" }) }),
    execute: async (_id, params) => asResult(await tars("POST", `/runs/${params.run_id}/cancel`, {})),
  });
}
