// discord_bridge.mjs
//
// Discord 论坛帖子 ↔ Claude Code 桥接。一个帖子 = 一个 Claude Code 会话 = 一个 dinotty pane。
//
// 主频道：  /cc 标题        开一个新会话(论坛里新建帖子 + dinotty 里新开一个跑 claude 的标签页)
//           /sessions      列出本机最近的 Claude 会话(包括在终端里直接开的)
//           /resume 编号   把列表里的某个会话接到一个新帖子里(在它原来的目录里 claude --resume)
//           /list          看已绑定的会话
//           /help [主题]   操作手册(sessions/chat/commands/faq/other；all 看全部；pin 置顶到主频道)
// 帖子里：  直接发消息 → 转给这个帖子的 Claude
//           /stop 中止当前任务 · /end 结束会话 · /screen 看终端画面 · /clear 换一个全新会话
//           /compact /model /effort /context /cost 原样转发 · /mode 用 Shift+Tab 切权限模式
//           弹选择框的交互式指令(/permissions /mcp /config /rewind…)Discord 里点不了，提示去 dinotty
//
// 状态展示：你的消息上的表情 👀 收到 → ⏳ 处理中 → ✅ 完成 / ❌ 出错；处理期间有一条进度消息
// 原地刷新(最近调用的工具、已用时间)；帖子标签在 "进行中" / "等待中" / "已完成" 之间切换。
//
// 收消息靠 discord_dm.mjs 写的 inbox.jsonl；建帖子、加表情、改标签直接调 Discord REST(bot token)；
// Claude 的回复和进度消息走 "Claude Code" webhook(~/.discord_dm/cc_webhook_url)。
// 进度和回复读的是 Claude 自己的对话记录(transcript)，不抠终端画面：每个会话用 --session-id 启动，
// 记录文件位置可预知，里面有工具调用和每轮结束的 turn_duration 标记；电脑重启后 pane 丢了，
// 下一条消息会用 --resume 接着原会话重开。
//
// 对 dinotty：只操作自己建的 pane。发消息/读画面用只限该 pane 的 agent token；建/关标签页、
// 确认信任提示、按 Esc 这几件 agent token 做不了的事才用全局 token。

import { readFile, writeFile, rename, open, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./load_env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const DATA_DIR = path.join(HOME, ".discord_dm");
const INBOX_FILE = path.join(__dirname, "inbox.jsonl");
const STATE_FILE = path.join(DATA_DIR, "bridge_state.json");
const LEGACY_STATE_FILE = path.join(__dirname, "bridge_state.json");
const WEBHOOK_FILE = path.join(DATA_DIR, "cc_webhook_url");
const DINOTTY_TOKEN_FILE = path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "dinotty", "token");

const DINOTTY = "http://127.0.0.1:8999";
const DEFAULT_CWD = HOME; // /cc 新开会话的工作目录；/resume 接上的会话用它自己原来的目录
const PROJECTS_DIR = path.join(HOME, ".claude", "projects");
const MAX_SESSIONS = 4;
const RECENTLY_ACTIVE_MS = 5 * 60 * 1000;
const POLL_MS = 2000;
const PROGRESS_EDIT_MS = 5000;
const TURN_TIMEOUT_MS = 30 * 60 * 1000;
const PANE_READY_TIMEOUT_MS = 90 * 1000;
const CHUNK = 1900;

const TAG_AGENT = "Claude Code";
const TAG_BUSY = "进行中";
const TAG_IDLE = "等待中";
const TAG_DONE = "已完成";
const BRIDGE_TAGS = [TAG_AGENT, "2B", TAG_BUSY, TAG_IDLE, TAG_DONE];

const env = await loadEnv();
const { DISCORD_TOKEN, DISCORD_CHANNEL_ID, DISCORD_FORUM_CHANNEL_ID, DISCORD_OWNER_ID } = env;
for (const [k, v] of Object.entries({ DISCORD_TOKEN, DISCORD_CHANNEL_ID, DISCORD_FORUM_CHANNEL_ID, DISCORD_OWNER_ID })) {
  if (!v) throw new Error(`缺 .env 配置：${k}`);
}
if (!existsSync(DINOTTY_TOKEN_FILE)) throw new Error(`找不到 dinotty 全局 token: ${DINOTTY_TOKEN_FILE}`);
const DINOTTY_GLOBAL = (await readFile(DINOTTY_TOKEN_FILE, "utf-8")).trim();
const WEBHOOK_URL = existsSync(WEBHOOK_FILE) ? (await readFile(WEBHOOK_FILE, "utf-8")).trim() : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 状态 ----------

async function readCompleteLines(file) {
  if (!existsSync(file)) return [];
  const parts = (await readFile(file, "utf-8")).split("\n");
  parts.pop();
  return parts.filter(Boolean);
}

async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });
  if (existsSync(STATE_FILE)) return JSON.parse(await readFile(STATE_FILE, "utf-8"));
  const state = { inboxLines: (await readCompleteLines(INBOX_FILE)).length, sessions: {} };
  // 旧版桥接只有一个固定帖子：把它迁移成一个会话，下次发消息时自动开新终端
  if (existsSync(LEGACY_STATE_FILE)) {
    const legacy = JSON.parse(await readFile(LEGACY_STATE_FILE, "utf-8"));
    state.inboxLines = legacy.inboxLines ?? state.inboxLines;
    if (legacy.threadId) {
      state.sessions[legacy.threadId] = newSession(legacy.threadId, "cc-bridge 会话");
    }
    await rename(LEGACY_STATE_FILE, `${LEGACY_STATE_FILE}.migrated`);
  }
  return state;
}

const projectDirFor = (cwd) => path.join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, "-"));

function newSession(threadId, title, { claudeSessionId = randomUUID(), cwd = DEFAULT_CWD, transcriptFile = null } = {}) {
  return {
    threadId,
    title,
    claudeSessionId,
    cwd,
    transcriptFile: transcriptFile ?? path.join(projectDirFor(cwd), `${claudeSessionId}.jsonl`),
    tabId: null,
    paneId: null,
    paneToken: null,
    paneTokenId: null,
    busy: false,
  };
}

const state = await loadState();
state.lastListing ??= [];
for (const s of Object.values(state.sessions)) {
  s.busy = false;
  s.cwd ??= DEFAULT_CWD;
  s.transcriptFile ??= path.join(projectDirFor(s.cwd), `${s.claudeSessionId}.jsonl`);
}
const saveState = () => writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
await saveState(); // 旧状态迁移完立刻落盘，免得还没收到消息就重启导致迁移结果丢失

// ---------- HTTP ----------

async function http(url, { method = "GET", headers = {}, body, maxRetryWaitMs = 10000 } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json", ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      const waitMs = Math.ceil((j.retry_after ?? 1) * 1000) + 100;
      if (waitMs > maxRetryWaitMs) throw new Error(`限流，需要等 ${Math.round(waitMs / 1000)} 秒`);
      await sleep(waitMs);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${method} ${url.replace(/\/webhooks\/\d+\/[^/?]+/, "/webhooks/***")} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }
  throw new Error("请求多次被限流");
}

const discord = (method, route, body, opts = {}) =>
  http(`https://discord.com/api/v10${route}`, { method, body, headers: { Authorization: `Bot ${DISCORD_TOKEN}` }, ...opts });

const dinotty = (method, route, body, token = DINOTTY_GLOBAL) =>
  http(`${DINOTTY}${route}`, { method, body, headers: { Authorization: `Bearer ${token}` } });

// ---------- Discord：消息、表情、标签 ----------

const NO_MENTIONS = { parse: [] };

async function postMessage(channelId, content, { asClaude = true } = {}) {
  if (asClaude && WEBHOOK_URL) {
    try {
      return await http(`${WEBHOOK_URL}?wait=true&thread_id=${channelId}`, { method: "POST", body: { content, allowed_mentions: NO_MENTIONS } });
    } catch (e) {
      console.error("[webhook] 发送失败，改用 bot 发:", e.message);
    }
  }
  const m = await discord("POST", `/channels/${channelId}/messages`, { content, allowed_mentions: NO_MENTIONS });
  m.viaBot = true;
  return m;
}

async function editMessage(channelId, msg, content) {
  if (!msg) return;
  if (!msg.viaBot && WEBHOOK_URL) {
    await http(`${WEBHOOK_URL}/messages/${msg.id}?thread_id=${channelId}`, { method: "PATCH", body: { content, allowed_mentions: NO_MENTIONS } });
  } else {
    await discord("PATCH", `/channels/${channelId}/messages/${msg.id}`, { content, allowed_mentions: NO_MENTIONS });
  }
}

function splitForDiscord(text) {
  const out = [];
  let rest = text;
  while (rest.length > CHUNK) {
    let cut = rest.lastIndexOf("\n", CHUNK);
    if (cut < CHUNK / 2) cut = CHUNK;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

async function postLong(channelId, text, opts) {
  for (const chunk of splitForDiscord(text)) await postMessage(channelId, chunk, opts);
}

const stripAnsi = (t) => t.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
// dinotty 读屏会在中文字符之间塞空格，这里还原
const fixCjkSpacing = (t) => t.replace(/(?<=[　-鿿＀-￯])\s(?=[　-鿿＀-￯])/g, "");
const toMain = { asClaude: false };

const quietly = (p, what) => p.catch((e) => console.error(`[${what}]`, e.message));

async function react(channelId, messageId, emoji, remove = false) {
  const route = `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`;
  await quietly(discord(remove ? "DELETE" : "PUT", route), `表情 ${emoji}`);
}

let tagIds = {};
async function ensureTags() {
  const forum = await discord("GET", `/channels/${DISCORD_FORUM_CHANNEL_ID}`);
  const existing = forum.available_tags ?? [];
  const missing = BRIDGE_TAGS.filter((n) => !existing.some((t) => t.name === n));
  let tags = existing;
  if (missing.length) {
    const updated = await discord("PATCH", `/channels/${DISCORD_FORUM_CHANNEL_ID}`, {
      available_tags: [...existing.map(({ id, name, moderated, emoji_id, emoji_name }) => ({ id, name, moderated, emoji_id, emoji_name })), ...missing.map((name) => ({ name }))],
    });
    tags = updated.available_tags;
    console.log(`[forum] 补齐标签: ${missing.join(", ")}`);
  }
  tagIds = Object.fromEntries(tags.map((t) => [t.name, t.id]));
}

async function setThreadStatus(threadId, status) {
  const applied = [tagIds[TAG_AGENT], tagIds[status]].filter(Boolean);
  // 帖子标签改得太勤会被限流，失败就算了，不影响对话
  await quietly(discord("PATCH", `/channels/${threadId}`, { applied_tags: applied }, { maxRetryWaitMs: 3000 }), "标签");
}

// ---------- dinotty pane ----------

const transcriptPath = (s) => s.transcriptFile;

async function paneAlive(s) {
  if (!s.paneId) return false;
  const r = await dinotty("GET", "/api/sessions");
  return r.sessions.some((x) => x.pane_id === s.paneId && x.status === "connected");
}

async function readScreen(s) {
  const r = await dinotty("GET", `/api/sessions/${s.paneId}/read?pane_id=${s.paneId}`, undefined, s.paneToken);
  return r.lines.map((l) => l.replace(/\s+$/, ""));
}

const isTrustPrompt = (lines) => lines.some((l) => l.includes("Yes, I trust this folder"));
const isPermissionPrompt = (lines) => lines.some((l) => /Do you want to (proceed|make this edit|create|allow)/i.test(l));
const hasInputPrompt = (lines) => lines.some((l) => /^\s*❯(\s|$)/.test(l));
// 选择框也会有 ❯，所以还要看到底部状态栏(状态行/模式提示)才算真正进入输入状态
const hasFooter = (lines) => lines.some((l) => /Model:|for shortcuts|mode on|accept edits|\/effort/.test(l));
const isReady = (lines) => !isTrustPrompt(lines) && hasInputPrompt(lines) && hasFooter(lines);

async function closePane(s) {
  if (s.tabId) await quietly(dinotty("DELETE", `/api/tabs/${s.tabId}`), "关标签页");
  if (s.paneTokenId) await quietly(dinotty("DELETE", `/api/tokens/${s.paneTokenId}`), "删 token");
  Object.assign(s, { tabId: null, paneId: null, paneToken: null, paneTokenId: null });
}

async function ensurePane(s) {
  if (await paneAlive(s)) return;
  await closePane(s);
  const resume = existsSync(transcriptPath(s));
  const tab = await dinotty("POST", "/api/tabs", {
    cwd: s.cwd.replace(/\\/g, "/"),
    argv: ["claude", resume ? "--resume" : "--session-id", s.claudeSessionId],
    title: `cc-bridge ${s.title}`.slice(0, 40),
  });
  s.tabId = tab.tab_id;
  s.paneId = tab.pane_id;
  const tok = await dinotty("POST", "/api/tokens", {
    name: `discord-cc-bridge-${s.threadId}`,
    capabilities: ["terminal:read", "terminal:write"],
    scopes: { "terminal:read": [s.paneId], "terminal:write": [s.paneId] },
    expires_in: 30 * 86400,
  });
  s.paneToken = tok.token;
  s.paneTokenId = tok.token_info.id;
  await saveState();

  const deadline = Date.now() + PANE_READY_TIMEOUT_MS;
  let lastTrustConfirm = 0;
  while (Date.now() < deadline) {
    await sleep(1500);
    const lines = await readScreen(s);
    if (isTrustPrompt(lines)) {
      if (Date.now() - lastTrustConfirm > 5000) {
        await dinotty("POST", `/api/sessions/${s.paneId}/input`, { data: "\u001b[B\r" });
        lastTrustConfirm = Date.now();
      }
      continue;
    }
    if (isReady(lines)) return;
  }
  throw new Error("Claude Code 终端 90 秒内没有进入输入状态，可以发 /screen 看看卡在哪个界面，或者去 dinotty 处理");
}

async function sendPrompt(s, text) {
  const t = text.trim();
  // 多行用括号粘贴(bracketed paste)整体送进去，不然每个换行都会被当成一次提交
  const payload = t.includes("\n") ? `\u001b[200~${t.replace(/\r?\n/g, "\n")}\u001b[201~\r` : `${t}\r`;
  await dinotty("POST", `/api/sessions/${s.paneId}/send`, { pane_id: s.paneId, command: payload }, s.paneToken);
}

// ---------- transcript ----------

async function fileSize(file) {
  return existsSync(file) ? statSync(file).size : 0;
}

async function readEntriesFrom(file, offset) {
  if (!existsSync(file)) return { entries: [], offset };
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    if (size <= offset) return { entries: [], offset };
    const buf = Buffer.alloc(size - offset);
    await fh.read(buf, 0, buf.length, offset);
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl === -1) return { entries: [], offset };
    const complete = text.slice(0, lastNl);
    const entries = complete
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return { entries, offset: offset + Buffer.byteLength(complete, "utf8") + 1 };
  } finally {
    await fh.close();
  }
}

function describeTool(c) {
  const i = c.input || {};
  let arg = i.file_path ? path.basename(String(i.file_path)) : i.command || i.pattern || i.url || i.query || i.description || i.path || "";
  arg = String(arg).replace(/\s+/g, " ").replace(/`/g, "'").slice(0, 80);
  return arg ? `${c.name}: ${arg}` : c.name;
}

function formatElapsed(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒`;
}

const isToolResult = (content) => Array.isArray(content) && content.some((c) => c.type === "tool_result");

// ---------- 一轮对话 ----------

async function runTurn(s, ev) {
  s.busy = true;
  s.stopRequested = false;
  const started = Date.now();
  s.turnStartedAt = started;
  s.currentTask = ev.content.slice(0, 300);
  s.recentTools = [];
  let progress = null;
  try {
    await react(s.threadId, ev.message_id, "👀", true);
    await react(s.threadId, ev.message_id, "⏳");
    await setThreadStatus(s.threadId, TAG_BUSY);
    progress = await postMessage(s.threadId, "⏳ Claude Code 收到，准备中…");

    await ensurePane(s);
    const file = transcriptPath(s);
    let offset = await fileSize(file);
    await sendPrompt(s, ev.content);

    let promptSeen = false;
    let done = false;
    let interrupted = false;
    let permissionWarned = false;
    let stopTicks = 0;
    let lastEdit = 0;
    const tools = [];
    let texts = [];

    while (!done) {
      await sleep(POLL_MS);
      const elapsed = Date.now() - started;
      if (elapsed > TURN_TIMEOUT_MS) throw new Error("超过 30 分钟还没结束，桥接先不等了（Claude 可能还在跑，去 dinotty 看）");

      const r = await readEntriesFrom(file, offset);
      offset = r.offset;
      for (const e of r.entries) {
        if (e.isSidechain) continue;
        const content = e.message?.content;
        if (e.type === "user" && JSON.stringify(content ?? "").includes("Request interrupted by user")) {
          interrupted = true;
          done = true;
          continue;
        }
        if (!promptSeen) {
          if (e.type === "user" && !isToolResult(content)) promptSeen = true;
          continue;
        }
        if (e.type === "assistant" && Array.isArray(content)) {
          for (const c of content) {
            if (c.type === "tool_use") {
              tools.push(describeTool(c));
              s.recentTools = tools.slice(-5);
              texts = [];
            } else if (c.type === "text" && c.text.trim()) {
              texts.push(c.text.trim());
            }
          }
        }
        if (e.type === "system" && e.subtype === "turn_duration") done = true;
      }
      if (done) break;
      // 按了 /stop 但记录里没写中断标记(比如还在思考阶段)，等几秒就不等了
      if (s.stopRequested && ++stopTicks >= 3) {
        interrupted = true;
        break;
      }

      if (!promptSeen && elapsed > 30000) throw new Error("消息没有送进 Claude（30 秒内没看到它收到），去 dinotty 看看终端是不是卡在别的提示上");

      if (Date.now() - lastEdit >= PROGRESS_EDIT_MS) {
        lastEdit = Date.now();
        const lines = await readScreen(s).catch(() => []);
        if (isPermissionPrompt(lines) && !permissionWarned) {
          permissionWarned = true;
          await postMessage(s.threadId, "⚠️ Claude 在等权限确认，请到 dinotty 的 cc-bridge 标签页处理，或者回复 /stop 中止。");
        }
        const recent = tools.length ? tools.slice(-5).map((t) => `• \`${t}\``).join("\n") : "思考中…";
        await quietly(editMessage(s.threadId, progress, `⏳ Claude Code 工作中 · 已用 ${formatElapsed(elapsed)}\n${recent}`), "进度");
      }
    }

    const took = formatElapsed(Date.now() - started);
    if (interrupted) {
      await quietly(editMessage(s.threadId, progress, `⏹ 已中止 · 用时 ${took} · 工具调用 ${tools.length} 次`), "进度");
      await react(s.threadId, ev.message_id, "⏳", true);
      await react(s.threadId, ev.message_id, "⏹️");
      return;
    }
    await quietly(editMessage(s.threadId, progress, `✅ 完成 · 用时 ${took} · 工具调用 ${tools.length} 次`), "进度");
    const reply = texts.join("\n\n") || "(Claude 这轮没有文字回复)";
    s.lastReply = reply.slice(0, 600);
    s.lastTurnEndedAt = Date.now();
    await postLong(s.threadId, reply);
    await react(s.threadId, ev.message_id, "⏳", true);
    await react(s.threadId, ev.message_id, "✅");
  } catch (e) {
    console.error(`[turn ${s.threadId}]`, e.message);
    if (progress) await quietly(editMessage(s.threadId, progress, `❌ 出错：${e.message}`), "进度");
    else await quietly(postMessage(s.threadId, `❌ 出错：${e.message}`), "出错提示");
    await react(s.threadId, ev.message_id, "⏳", true);
    await react(s.threadId, ev.message_id, "❌");
  } finally {
    s.busy = false;
    await saveState();
    await setThreadStatus(s.threadId, TAG_IDLE);
  }
}

// ---------- 命令 ----------

const queues = new Map();
function enqueue(threadId, job) {
  const next = (queues.get(threadId) ?? Promise.resolve()).then(job).catch((e) => console.error(`[队列 ${threadId}]`, e.message));
  queues.set(threadId, next);
}

// ---------- 操作手册：/help 看总览，/help 主题 看细节 ----------

const THREAD_HELP = [
  "**会话帖子里**：直接发消息就是跟 Claude 说话",
  "`/stop` 中止当前任务 · `/end` 结束会话并关掉终端 · `/screen` 看终端当前画面",
  "`/clear` 开一个全新会话 · `/compact` 压缩上下文 · `/mode plan|auto|accept|default`",
  "更多用法发 `/help`",
].join("\n");

const HELP_TOPICS = {
  "2b": {
    aliases: ["前台", "frontdesk"],
    title: "跟 2B 说话(前台)",
    body: [
      "在**主频道**直接说话(不用加 `/`)，就是在跟 2B 聊。2B 是你的前台，会帮你调度 Claude Code：",
      "• 「帮我整理一下下载文件夹」→ 2B 开一个 Claude Code 会话，把任务交过去，告诉你去哪个帖子看",
      "• 「刚才那个整理得怎么样了」→ 2B 查进度告诉你",
      "• 「把昨天小红书那个会话接回来」→ 2B 帮你找到并接上",
      "• 「停一下」「那个会话可以关了」→ 2B 帮你中止或结束(会先确认是哪个)",
      "• 「帮我在小红书搜一下 xxx」→ 2B 用 tars-pilot 在自动化浏览器里操作，不占用你的鼠标",
      "轻量小事(看个文件、跑条命令)2B 自己做；大活交给 Claude Code。删除、发消息、提交代码这类操作它会先问你。",
      "2B 会按你这句话属于哪个领域(学习/开发/生活…)切换说话方式，配置来自 frontdesk。",
      "2B 收到你的消息会显示「正在输入…」，回完你的消息上会出现 ✅。",
      "2B 在主频道的聊天是一段连续的对话，跨天也接着。她还有一个长期记忆文件，会自己记下你的偏好和交代的事；跟她说「记住…」「忘掉…」就行。",
      "`/2b new` 让 2B 开始一段新对话(忘掉聊天内容，但长期记忆文件里记下的还在)。",
    ],
  },
  sessions: {
    aliases: ["会话", "session"],
    title: "会话：开新的、接旧的",
    body: [
      "一个论坛帖子 = 一个 Claude Code 会话 = dinotty 里一个终端标签页。下面这些都在**主频道**发：",
      "• `/cc 标题` — 开一个全新会话，论坛里会多一个 `[cc] 标题` 的帖子，等它说「🟢 已就绪」再聊",
      "• `/sessions` — 列出本机最近 10 个 Claude 会话(包括你在电脑终端里开的)，带标题、最后一句、目录、时间",
      "• `/resume 编号` — 把列表里的某个会话接到一个新帖子里，之前的上下文都在",
      "• `/resume 编号!` — 标了 ⚠️ 的会话(5 分钟内还在更新，可能正开在别处)要加 `!` 确认才接",
      "• `/list` — 看现在绑定了哪些帖子、各自是 🟢空闲 / ⏳工作中 / ⚪终端未启动",
      `同时最多 ${MAX_SESSIONS} 个会话。用完在帖子里发 \`/end\`，对话记录会保留，之后还能 \`/resume\` 回来。`,
    ],
  },
  chat: {
    aliases: ["聊天", "状态", "status"],
    title: "聊天和状态显示",
    body: [
      "在会话帖子里直接发消息，就是在跟这个帖子的 Claude 说话；多行消息会整体发过去。",
      "**你的消息上的表情**：👀 收到 → ⏳ 处理中 → ✅ 完成 / ❌ 出错 / ⏹️ 已中止",
      "**进度消息**：处理期间每 5 秒刷新一次，显示已用时间和最近 5 个动作(读了哪个文件、跑了什么命令)，结束后变成「✅ 完成 · 用时 · 工具调用次数」。",
      "**帖子标签**：进行中 / 等待中 / 已完成，在论坛列表里一眼看到哪个会话在跑。",
      "Claude 在干活时你又发了消息，会排队，等这轮结束再发给它。想打断用 `/stop`。",
    ],
  },
  commands: {
    aliases: ["指令", "命令", "cmd"],
    title: "帖子里能用的 Claude Code 指令",
    body: [
      "**原样转发给 Claude**(输出会发回帖子)：",
      "• `/compact` 压缩上下文(可能要等几分钟)",
      "• `/model 名字` 换模型，例如 `/model sonnet`、`/model opus`",
      "• `/effort 档位` 调思考强度，例如 `/effort high`",
      "• `/context` 看上下文占用 · `/cost` 看花费",
      "**桥接自己实现**：",
      "• `/mode plan|auto|accept|default` 切权限模式(plan=只规划不动手，auto=自动模式，accept=自动接受编辑)",
      "• `/clear` 在同一个帖子里换一个全新会话(旧会话没删，可以 `/resume` 找回)",
      "• `/screen` 把终端当前画面发回来，任何情况都能先看一眼",
      "• `/stop` 中止当前任务 · `/end` 结束会话、关掉终端",
      "**Discord 里用不了**：`/permissions` `/mcp` `/config` `/rewind` 这类会弹出选择界面的，请到 dinotty 的标签页里操作。`/model` `/effort` 不带参数也会弹选择框，所以必须带参数。",
    ],
  },
  faq: {
    aliases: ["问题", "排错", "troubleshoot"],
    title: "常见问题",
    body: [
      "• **发了消息没反应**：看消息上有没有 👀。没有的话先确认是在会话帖子里发的，再在主频道发 `/list` 看会话还在不在。",
      "• **提示 Claude 在等权限确认**：到 dinotty 对应的 cc-bridge 标签页里选一下，或者回复 `/stop` 放弃这一步。",
      "• **终端启动失败 / 90 秒没就绪**：发 `/screen` 看卡在哪个界面；dinotty 没开的话先把它打开。",
      "• **电脑重启过**：不用管，下一条消息会自动重开终端并接上原来的对话。",
      "• **超过 30 分钟还没结束**：桥接不再等了，但 Claude 可能还在跑，`/screen` 或 dinotty 里看进度。",
      "• **resume 时提示还在更新**：那个会话可能正开在电脑终端里，两边同时用会把记录写乱。确认没在用再 `/resume 编号!`。",
    ],
  },
  other: {
    aliases: ["其他", "睡眠", "sleep"],
    title: "其他功能",
    body: [
      "• 在**主频道**发 `睡眠` 或 `sleep`：电脑会回一句晚安，然后进入睡眠。",
      "• 只有你本人(DISCORD_OWNER_ID)发的消息才会被处理，别人发的指令会被忽略。",
      "• 2B 前台的用法见 `/help 2b`。",
    ],
  },
};

function helpOverview() {
  return [
    "**📖 Discord ↔ Claude Code 操作手册**",
    "",
    "**最省事的用法**：在主频道直接跟 2B 说你要干什么，它会帮你开 Claude Code 会话、交任务、查进度。",
    "",
    "**自己动手**",
    "1. 主频道发 `/cc 标题` 开一个会话(或 `/sessions` + `/resume 编号` 接上以前的会话)",
    "2. 进入论坛里新出现的 `[cc] 标题` 帖子，等它说「🟢 已就绪」",
    "3. 直接在帖子里说话；表情和进度消息会告诉你 Claude 在干什么",
    "",
    "**详细说明**：发 `/help 主题`",
    ...Object.entries(HELP_TOPICS).map(([key, t]) => `• \`/help ${key}\`(${t.aliases[0]}) — ${t.title}`),
    "",
    "`/help all` 一次看全部 · `/help pin` 把这份手册置顶到主频道",
  ].join("\n");
}

function findHelpTopic(name) {
  const n = name.toLowerCase();
  return Object.entries(HELP_TOPICS).find(([key, t]) => key === n || t.aliases.includes(n))?.[1] ?? null;
}

const renderTopic = (t) => `**${t.title}**\n${t.body.join("\n")}`;

async function pinManual() {
  const content = helpOverview();
  if (state.manualMessageId) {
    try {
      await discord("PATCH", `/channels/${DISCORD_CHANNEL_ID}/messages/${state.manualMessageId}`, { content, allowed_mentions: NO_MENTIONS });
      await discord("PUT", `/channels/${DISCORD_CHANNEL_ID}/pins/${state.manualMessageId}`);
      await postMessage(DISCORD_CHANNEL_ID, "置顶的操作手册已更新。点频道右上角的 📌 就能看到。", toMain);
      return;
    } catch {
      // 之前置顶的那条被删了，重新发一条
    }
  }
  const m = await postMessage(DISCORD_CHANNEL_ID, content, toMain);
  await discord("PUT", `/channels/${DISCORD_CHANNEL_ID}/pins/${m.id}`);
  state.manualMessageId = m.id;
  await saveState();
}

async function showHelp(channelId, arg, opts) {
  const topic = arg.trim();
  if (!topic) return postMessage(channelId, helpOverview(), opts);
  if (topic === "pin") return pinManual();
  if (topic === "all") {
    return postLong(channelId, Object.values(HELP_TOPICS).map(renderTopic).join("\n\n"), opts);
  }
  const t = findHelpTopic(topic);
  if (!t) return postMessage(channelId, `没有「${topic}」这个主题。\n\n${helpOverview()}`, opts);
  return postMessage(channelId, renderTopic(t), opts);
}

function sessionLimitReached() {
  return Object.keys(state.sessions).length >= MAX_SESSIONS;
}

// 给用户看的业务错误(会话满了、编号不对之类)，区别于程序出错
class BridgeError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const LIMIT_MESSAGE = `最多同时 ${MAX_SESSIONS} 个会话，先在不用的帖子里发 \`/end\` 关掉一个。`;

// 新建论坛帖子 + 绑定会话 + 后台启动终端；announce=false 时不在主频道发"已开会话"(2B 自己会说)
async function openThreadSession(threadName, intro, sessionTitle, sessionOpts, readyText, { announce = true } = {}) {
  const thread = await discord("POST", `/channels/${DISCORD_FORUM_CHANNEL_ID}/threads`, {
    name: threadName.slice(0, 100),
    message: { content: `${intro}\n\n${THREAD_HELP}` },
    applied_tags: [tagIds[TAG_AGENT], tagIds[TAG_IDLE]].filter(Boolean),
  });
  const s = newSession(thread.id, sessionTitle, sessionOpts);
  state.sessions[thread.id] = s;
  await saveState();
  if (announce) await postMessage(DISCORD_CHANNEL_ID, `已开会话 <#${thread.id}>`, toMain);
  enqueue(thread.id, async () => {
    try {
      await ensurePane(s);
      await saveState();
      await postMessage(thread.id, readyText);
    } catch (e) {
      await postMessage(thread.id, `❌ 终端启动失败：${e.message}`);
    }
  });
  return s;
}

async function openNewCcSession(title, { cwd = DEFAULT_CWD, announce = true } = {}) {
  if (sessionLimitReached()) throw new BridgeError(LIMIT_MESSAGE, "limit");
  if (!existsSync(cwd)) throw new BridgeError(`目录不存在：${cwd}`, "bad_cwd");
  return openThreadSession(`[cc] ${title}`, "Claude Code 新会话。终端启动中，好了会在这里说一声。", title, { cwd }, "🟢 Claude Code 已就绪，直接发消息吧。", { announce });
}

async function createSession(title) {
  try {
    await openNewCcSession(title);
  } catch (e) {
    if (!(e instanceof BridgeError)) throw e;
    await postMessage(DISCORD_CHANNEL_ID, e.message, toMain);
  }
}

// 把一条消息作为任务交给某个会话：先以 2B 的身份在帖子里贴出来，再排队发给 Claude
async function deliverToSession(s, text, from = "2B") {
  const preview = `📝 **${from} 转交的任务**\n${text}`;
  const m = await postMessage(s.threadId, preview.length > 1990 ? `${preview.slice(0, 1980)}…` : preview, toMain);
  await react(s.threadId, m.id, "👀");
  enqueue(s.threadId, () => runTurn(s, { message_id: m.id, content: text }));
}

// ---------- 本机的 Claude 会话列表 / 恢复 ----------

async function readSlice(file, start, length) {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

const parseJsonLines = (text) =>
  text
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

// claude --resume 要在会话"所属项目"的目录里跑才找得到它；会话中途可能 cd 过，记录里的 cwd
// 不一定是那个目录。所以在出现过的所有 cwd(和它们的上级目录)里，找名字能对上记录文件夹的那个。
function resolveSessionCwd(file, cwds) {
  const want = path.basename(path.dirname(file));
  for (const c of cwds) {
    for (let d = c; ; d = path.dirname(d)) {
      if (d.replace(/[^a-zA-Z0-9]/g, "-") === want) return d;
      if (path.dirname(d) === d) break;
    }
  }
  return null;
}

// 只读文件头尾：头尾都拿 cwd，尾部拿标题和最后一句(这两类条目会随对话反复追加)
async function describeClaudeSession(file, size, mtimeMs) {
  const head = parseJsonLines(await readSlice(file, 0, Math.min(size, 64 * 1024)));
  const tailStart = Math.max(0, size - 256 * 1024);
  const tail = parseJsonLines(await readSlice(file, tailStart, size - tailStart));
  const all = [...head, ...tail];
  const latest = (type, key) => {
    for (let i = all.length - 1; i >= 0; i--) if (all[i].type === type && all[i][key]) return all[i][key];
    return null;
  };
  return {
    sessionId: path.basename(file, ".jsonl"),
    file,
    cwd: resolveSessionCwd(file, [...new Set(all.map((e) => e.cwd).filter(Boolean))]),
    title: latest("custom-title", "customTitle") ?? latest("ai-title", "aiTitle"),
    lastPrompt: latest("last-prompt", "lastPrompt"),
    mtimeMs,
  };
}

async function listClaudeSessions(limit) {
  const files = [];
  for (const d of await readdir(PROJECTS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
    for (const f of await readdir(dir).catch(() => [])) {
      if (!/^[0-9a-f-]{36}\.jsonl$/.test(f)) continue;
      const full = path.join(dir, f);
      const st = await stat(full).catch(() => null);
      if (st?.size) files.push({ file: full, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const d = await describeClaudeSession(f.file, f.size, f.mtimeMs).catch(() => null);
    if (d?.cwd && (d.title || d.lastPrompt)) out.push(d);
  }
  return out;
}

function formatAgo(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}小时前` : `${Math.floor(h / 24)}天前`;
}

const boundSessionFor = (claudeSessionId) => Object.values(state.sessions).find((s) => s.claudeSessionId === claudeSessionId);

async function showClaudeSessions() {
  const list = await listClaudeSessions(10);
  state.lastListing = list.map(({ sessionId, file, cwd, title }) => ({ sessionId, file, cwd, title }));
  await saveState();
  if (!list.length) {
    await postMessage(DISCORD_CHANNEL_ID, "没找到本机的 Claude 会话记录。", toMain);
    return;
  }
  const rows = list.map((d, i) => {
    const bound = boundSessionFor(d.sessionId);
    const flags = [];
    if (bound) flags.push(`已绑定 <#${bound.threadId}>`);
    else if (Date.now() - d.mtimeMs < RECENTLY_ACTIVE_MS) flags.push("⚠️ 最近还在更新");
    const prompt = (d.lastPrompt ?? "").replace(/\s+/g, " ").slice(0, 60);
    return `**${i + 1}. ${d.title ?? "(无标题)"}** · ${formatAgo(Date.now() - d.mtimeMs)} · \`${d.cwd}\`${flags.length ? " · " + flags.join(" · ") : ""}\n　└ ${prompt || "…"}`;
  });
  rows.push("接上某个会话：`/resume 编号`。标了 ⚠️ 的可能正开在别的终端里，两边同时用会把记录写乱，确认要接就用 `/resume 编号!`");
  await postLong(DISCORD_CHANNEL_ID, rows.join("\n"), toMain);
}

// item: { sessionId, file, cwd, title }
async function resumeItem(item, force, { announce = true } = {}) {
  const bound = boundSessionFor(item.sessionId);
  if (bound) throw new BridgeError(`这个会话已经绑定在 <#${bound.threadId}> 了，直接去那里聊。`, "already_bound");
  if (sessionLimitReached()) throw new BridgeError(LIMIT_MESSAGE, "limit");
  const st = await stat(item.file).catch(() => null);
  if (!st) throw new BridgeError("这个会话的记录文件找不到了。", "missing");
  const idleMs = Date.now() - st.mtimeMs;
  if (!force && idleMs < RECENTLY_ACTIVE_MS) {
    throw new BridgeError(
      `「${item.title ?? item.sessionId.slice(0, 8)}」${formatAgo(idleMs)}还在更新，可能正开在别的终端里，两边同时用会把记录写乱。`,
      "recently_active"
    );
  }
  const title = item.title ?? `会话 ${item.sessionId.slice(0, 8)}`;
  return openThreadSession(
    `[cc] ${title}`,
    `接上之前的 Claude Code 会话「${title}」（目录 \`${item.cwd}\`）。终端启动中，好了会在这里说一声。`,
    title,
    { claudeSessionId: item.sessionId, cwd: item.cwd, transcriptFile: item.file },
    `🟢 已接上「${title}」，之前的上下文都在，直接发消息继续聊。`,
    { announce }
  );
}

async function resumeClaudeSession(n, force) {
  const item = state.lastListing[n - 1];
  if (!item) {
    await postMessage(DISCORD_CHANNEL_ID, "编号不对，先发 `/sessions` 看列表。", toMain);
    return;
  }
  try {
    await resumeItem(item, force);
  } catch (e) {
    if (!(e instanceof BridgeError)) throw e;
    const hint = e.code === "recently_active" ? `确认要接请发 \`/resume ${n}!\`` : e.code === "missing" ? "重新 `/sessions` 看看。" : "";
    await postMessage(DISCORD_CHANNEL_ID, `${e.message}${hint}`, toMain);
  }
}

// ---------- 帖子里的 Claude Code 指令 ----------

// 原样转发、输出会写进记录(local-command-stdout)的指令
const PASSTHROUGH = new Set(["/compact", "/model", "/effort", "/context", "/cost"]);
// 不带参数会弹选择框的指令
const NEEDS_ARG = new Set(["/model", "/effort"]);

async function screenText(s) {
  const lines = (await readScreen(s)).map((l) => fixCjkSpacing(stripAnsi(l)));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let text = lines.join("\n");
  if (text.length > 1800) text = text.slice(-1800);
  return text.replace(/```/g, "'''");
}

async function showScreen(s) {
  if (!(await paneAlive(s).catch(() => false))) {
    await postMessage(s.threadId, "终端还没启动（下一条消息会自动启动）。");
    return;
  }
  await postMessage(s.threadId, "```\n" + (await screenText(s)) + "\n```");
}

async function runLocalCommand(s, ev, commandText) {
  s.busy = true;
  try {
    await react(s.threadId, ev.message_id, "👀", true);
    await react(s.threadId, ev.message_id, "⏳");
    await ensurePane(s);
    const file = transcriptPath(s);
    let offset = await fileSize(file);
    await sendPrompt(s, commandText);
    const deadline = Date.now() + (commandText.startsWith("/compact") ? 10 * 60 * 1000 : 30 * 1000);
    let output = null;
    while (output === null && Date.now() < deadline) {
      await sleep(POLL_MS);
      const r = await readEntriesFrom(file, offset);
      offset = r.offset;
      for (const e of r.entries) {
        const c = e.message?.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x.text ?? "").join("") : "";
        const m = text.match(/<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/);
        if (m) output = stripAnsi(m[1]).trim() || "(执行完了，没有输出)";
        else if (e.type === "system" && e.subtype === "compact_boundary") output = "已压缩上下文。";
      }
    }
    if (output === null) {
      // 有些指令只在界面上显示、不写记录，退回截一下屏
      output = "（这个指令的结果没写进记录，下面是终端当前画面）\n```\n" + (await screenText(s)) + "\n```";
    }
    await postLong(s.threadId, output);
    await react(s.threadId, ev.message_id, "⏳", true);
    await react(s.threadId, ev.message_id, "✅");
  } catch (e) {
    await postMessage(s.threadId, `❌ 出错：${e.message}`);
    await react(s.threadId, ev.message_id, "⏳", true);
    await react(s.threadId, ev.message_id, "❌");
  } finally {
    s.busy = false;
    await saveState();
  }
}

const MODE_PATTERNS = { plan: /plan mode on/i, auto: /auto mode on/i, accept: /accept edits on/i };
function currentMode(lines) {
  const text = lines.join("\n");
  for (const [mode, re] of Object.entries(MODE_PATTERNS)) if (re.test(text)) return mode;
  return "default";
}

async function setMode(s, target) {
  if (!["plan", "auto", "accept", "default"].includes(target)) {
    await postMessage(s.threadId, "用法：`/mode plan`、`/mode auto`、`/mode accept`(自动接受编辑)、`/mode default`");
    return;
  }
  await ensurePane(s);
  // Shift+Tab 在几个模式之间循环，按一下看一眼底栏，直到切到目标模式
  for (let i = 0; i < 6; i++) {
    const cur = currentMode(await readScreen(s));
    if (cur === target) {
      await postMessage(s.threadId, `已切换到 ${target} 模式。`);
      return;
    }
    await dinotty("POST", `/api/sessions/${s.paneId}/input`, { data: "\u001b[Z" });
    await sleep(800);
  }
  await postMessage(s.threadId, `切了几轮还是没切到 ${target}（现在是 ${currentMode(await readScreen(s))}），可能你的设置里没开这个模式。`);
}

async function clearSession(s) {
  await closePane(s);
  const fresh = newSession(s.threadId, s.title, { cwd: s.cwd });
  s.claudeSessionId = fresh.claudeSessionId;
  s.transcriptFile = fresh.transcriptFile;
  await saveState();
  await ensurePane(s);
  await saveState();
  await postMessage(s.threadId, "🧹 已换成一个全新的 Claude 会话。旧会话没删，可以在主频道 `/sessions` + `/resume` 找回。");
}

async function guarded(s, what, fn) {
  try {
    await fn();
  } catch (e) {
    await postMessage(s.threadId, `❌ ${what}失败：${e.message}`);
  }
}

async function listSessions() {
  const all = Object.values(state.sessions);
  if (!all.length) {
    await postMessage(DISCORD_CHANNEL_ID, "现在没有会话。发 `/cc 标题` 开一个。", { asClaude: false });
    return;
  }
  const lines = await Promise.all(
    all.map(async (s) => {
      const alive = await paneAlive(s).catch(() => false);
      const st = s.busy ? "⏳ 工作中" : alive ? "🟢 空闲" : "⚪ 终端未启动(下条消息会自动开)";
      return `• <#${s.threadId}> ${s.title} — ${st}`;
    })
  );
  await postMessage(DISCORD_CHANNEL_ID, lines.join("\n"), { asClaude: false });
}

async function stopSession(s) {
  if (!s.busy || !s.paneId) {
    await postMessage(s.threadId, "现在没有在跑的任务。");
    return;
  }
  s.stopRequested = true;
  await dinotty("POST", `/api/sessions/${s.paneId}/input`, { data: "\u001b" });
}

async function endSession(s) {
  await closePane(s);
  delete state.sessions[s.threadId];
  await saveState();
  await postMessage(s.threadId, "会话已结束，终端已关闭。对话记录还在，想接着聊可以在主频道 `/sessions` 找到它再 `/resume`。");
  await quietly(discord("PATCH", `/channels/${s.threadId}`, { applied_tags: [tagIds[TAG_AGENT], tagIds[TAG_DONE]].filter(Boolean) }, { maxRetryWaitMs: 3000 }), "标签");
}

async function handleMessage(ev) {
  if (ev.author_id !== DISCORD_OWNER_ID) return;
  const text = ev.content.trim();

  if (ev.thread_id) {
    const s = state.sessions[ev.thread_id];
    if (!s || !text) return;
    if (text.startsWith("/")) return handleThreadCommand(s, ev, text);
    await react(s.threadId, ev.message_id, "👀");
    enqueue(s.threadId, () => runTurn(s, ev));
    return;
  }

  if (ev.channel_id !== DISCORD_CHANNEL_ID) return;
  const cc = text.match(/^\/cc(?:\s+(.+))?$/s);
  if (cc) return createSession((cc[1] || "未命名").trim());
  const resume = text.match(/^\/resume\s+(\d+)(!?)$/);
  if (resume) return resumeClaudeSession(Number(resume[1]), resume[2] === "!");
  if (text === "/resume") return postMessage(DISCORD_CHANNEL_ID, "用法：先 `/sessions` 看列表，再 `/resume 编号`。", toMain);
  if (text === "/sessions") return showClaudeSessions();
  if (text === "/list") return listSessions();
  const help = text.match(/^\/help(?:\s+(.*))?$/s);
  if (help) return showHelp(DISCORD_CHANNEL_ID, help[1] ?? "", toMain);
  if (text === "/2b new") return reset2b();
  if (!text || text.startsWith("/")) return;
  // 其余的话都交给前台 2B
  await react(DISCORD_CHANNEL_ID, ev.message_id, "👀");
  enqueue(TWOB_QUEUE, () => run2bTurn(ev));
}

// ---------- 2B 前台(pi agent) ----------
//
// 主频道里不是指令的消息交给 2B：每条消息调用一次 `pi -p`，用固定的 session-id 保持对话上下文。
// 2B 不加载用户自己的 pi 扩展(frontdesk 会让 -p 模式不退出)，只把 frontdesk 的领域提示词配置抽成 2b_profiles.md 带上。
// 工具：pi 自带的 read/bash/edit/write(轻量小活自己做)，加上 pi_2b_tools.ts 里经下面的本地接口调度 Claude Code、
// 经 tars-pilot 做网页操作的工具。回复由 bot 发出，bot 名字就是 2B。

const TWOB_QUEUE = "__2b__";
const PI_CLI = path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const TWOB_EXTENSION = path.join(__dirname, "pi_2b_tools.ts");
const TWOB_PROMPT = path.join(__dirname, "2b_prompt.md");
const TWOB_PROFILES = path.join(__dirname, "2b_profiles.md"); // 抽自 frontdesk.ts 的 PROMPT_PROFILES，按领域切换说话方式和规矩
// 2B 的长期记忆：每次回复前作为系统提示词读进去，她用自己的编辑工具维护。是用户的个人数据，所以放仓库外。
const TWOB_MEMORY = path.join(DATA_DIR, "2b_memory.md");
if (!existsSync(TWOB_MEMORY)) {
  await writeFile(
    TWOB_MEMORY,
    "# 2B 的记忆\n\n(这是 2B 自己维护的长期记忆，每次回复前都会读到。)\n\n## zym 的偏好\n\n## 长期交代的事\n\n## 正在跟进的事\n\n## 其他要记住的\n",
    "utf-8"
  );
}
const TWOB_TIMEOUT_MS = 15 * 60 * 1000; // 网页操作冷启动模型就要一分多钟，留足时间
state.frontdeskSessionId ??= randomUUID();

function runPi(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        PI_CLI, "-p", "--session-id", state.frontdeskSessionId, "--no-extensions", "--no-context-files",
        "-e", TWOB_EXTENSION, "--append-system-prompt", TWOB_PROMPT, "--append-system-prompt", TWOB_PROFILES,
        "--append-system-prompt", TWOB_MEMORY,
      ],
      {
        cwd: HOME,
        windowsHide: true,
        env: { ...process.env, DISCORD_BRIDGE_API: `http://127.0.0.1:${API_PORT}`, DISCORD_BRIDGE_TOKEN_FILE: API_TOKEN_FILE },
      }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("2B 15 分钟还没回，先放弃这一条"));
    }, TWOB_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(stripAnsi(err || out).trim().slice(-400) || `pi 退出码 ${code}`));
    });
    child.stdin.end(prompt);
  });
}

async function run2bTurn(ev) {
  const ch = DISCORD_CHANNEL_ID;
  const typing = () => quietly(discord("POST", `/channels/${ch}/typing`), "typing");
  await typing();
  const timer = setInterval(typing, 8000); // "2B 正在输入…" 每次只持续约 10 秒，要不停续
  try {
    const reply = await runPi(ev.content);
    await postLong(ch, reply, toMain);
    await react(ch, ev.message_id, "👀", true);
    await react(ch, ev.message_id, "✅");
  } catch (e) {
    console.error("[2B]", e.message);
    await postMessage(ch, `❌ 2B 出错了：${e.message}`, toMain);
    await react(ch, ev.message_id, "👀", true);
    await react(ch, ev.message_id, "❌");
  } finally {
    clearInterval(timer);
  }
}

async function reset2b() {
  state.frontdeskSessionId = randomUUID();
  await saveState();
  await postMessage(DISCORD_CHANNEL_ID, "好，2B 这边开始一段新对话了（之前的聊天内容不再记得，长期记忆文件里记下的还在）。", toMain);
}

// ---------- 给 2B 用的本地接口(只监听 127.0.0.1，带密钥) ----------

const API_PORT = 8793;
const API_TOKEN_FILE = path.join(DATA_DIR, "bridge_api_token");
if (!existsSync(API_TOKEN_FILE)) await writeFile(API_TOKEN_FILE, randomBytes(24).toString("hex"), "utf-8");
const API_TOKEN = (await readFile(API_TOKEN_FILE, "utf-8")).trim();

function sessionSummary(s) {
  return {
    thread_id: s.threadId,
    link: `<#${s.threadId}>`,
    title: s.title,
    cwd: s.cwd,
    busy: Boolean(s.busy),
    current_task: s.busy ? s.currentTask ?? null : null,
    running_for: s.busy && s.turnStartedAt ? formatElapsed(Date.now() - s.turnStartedAt) : null,
    recent_actions: s.busy ? s.recentTools ?? [] : [],
    last_reply: s.lastReply ?? null,
    last_finished: s.lastTurnEndedAt ? formatAgo(Date.now() - s.lastTurnEndedAt) : null,
  };
}

function requireSession(threadId) {
  const s = state.sessions[threadId];
  if (!s) throw new BridgeError(`没有这个会话：${threadId}。先用 cc_status 看看现有的会话。`, "no_session");
  return s;
}

const apiRoutes = {
  "GET /sessions": async (q) => ({
    sessions: Object.values(state.sessions)
      .filter((s) => !q.thread_id || s.threadId === q.thread_id)
      .map(sessionSummary),
    max_sessions: MAX_SESSIONS,
  }),
  "GET /history": async (q) => {
    const list = await listClaudeSessions(Math.min(Number(q.limit) || 10, 30));
    return {
      sessions: list.map((d) => {
        const bound = boundSessionFor(d.sessionId);
        return {
          session_id: d.sessionId,
          title: d.title,
          last_prompt: (d.lastPrompt ?? "").slice(0, 120),
          cwd: d.cwd,
          updated: formatAgo(Date.now() - d.mtimeMs),
          recently_active: !bound && Date.now() - d.mtimeMs < RECENTLY_ACTIVE_MS,
          bound_thread: bound ? `<#${bound.threadId}>` : null,
        };
      }),
    };
  },
  "POST /cc/open": async (_q, b) => {
    if (!b.title) throw new BridgeError("缺少 title");
    const s = await openNewCcSession(String(b.title).slice(0, 90), { cwd: b.cwd || DEFAULT_CWD, announce: false });
    if (b.task) await deliverToSession(s, String(b.task));
    return { thread_id: s.threadId, link: `<#${s.threadId}>`, task_delivered: Boolean(b.task) };
  },
  "POST /cc/send": async (_q, b) => {
    const s = requireSession(b.thread_id);
    if (!b.text) throw new BridgeError("缺少 text");
    const wasBusy = Boolean(s.busy);
    await deliverToSession(s, String(b.text));
    return { ok: true, link: `<#${s.threadId}>`, queued_behind_running_task: wasBusy };
  },
  "POST /cc/resume": async (_q, b) => {
    const item = (await listClaudeSessions(50)).find((d) => d.sessionId === b.session_id);
    if (!item) throw new BridgeError("找不到这个 session_id，先用 cc_list_history 看看。", "missing");
    const s = await resumeItem(item, Boolean(b.force), { announce: false });
    return { thread_id: s.threadId, link: `<#${s.threadId}>` };
  },
  "POST /cc/stop": async (_q, b) => {
    const s = requireSession(b.thread_id);
    if (!s.busy || !s.paneId) return { stopped: false, reason: "这个会话现在没有在跑的任务" };
    await stopSession(s);
    return { stopped: true };
  },
  "POST /cc/end": async (_q, b) => {
    const s = requireSession(b.thread_id);
    enqueue(s.threadId, () => guarded(s, "结束会话", () => endSession(s)));
    return { ending: true, note: s.busy ? "当前任务做完后再结束" : "马上结束" };
  },
};

function startApiServer() {
  const server = createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.headers.authorization !== `Bearer ${API_TOKEN}`) return send(401, { error: "unauthorized" });
      const url = new URL(req.url, "http://127.0.0.1");
      const handler = apiRoutes[`${req.method} ${url.pathname}`];
      if (!handler) return send(404, { error: "没有这个接口" });
      let body = {};
      if (req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      send(200, await handler(Object.fromEntries(url.searchParams), body));
    } catch (e) {
      if (!(e instanceof BridgeError)) console.error("[api]", e.message);
      send(e instanceof BridgeError ? 400 : 500, { error: e.message, code: e.code });
    }
  });
  server.on("error", (e) => console.error("[api] 本地接口启动失败(2B 的工具会用不了):", e.message));
  server.listen(API_PORT, "127.0.0.1", () => console.log(`[api] 2B 工具接口在 127.0.0.1:${API_PORT}`));
}

async function handleThreadCommand(s, ev, text) {
  const cmd = text.split(/\s+/, 1)[0].toLowerCase();
  const arg = text.slice(cmd.length).trim();
  switch (cmd) {
    case "/stop":
      return stopSession(s);
    case "/screen":
      return guarded(s, "读终端画面", () => showScreen(s));
    case "/help":
      return guarded(s, "显示帮助", () => showHelp(s.threadId, arg));
    case "/end":
      return enqueue(s.threadId, () => guarded(s, "结束会话", () => endSession(s)));
    case "/clear":
      return enqueue(s.threadId, () => guarded(s, "清空会话", () => clearSession(s)));
    case "/mode":
      return enqueue(s.threadId, () => guarded(s, "切换模式", () => setMode(s, arg.toLowerCase())));
  }
  if (PASSTHROUGH.has(cmd)) {
    if (NEEDS_ARG.has(cmd) && !arg) {
      return postMessage(s.threadId, `\`${cmd}\` 要带参数，比如 \`/model sonnet\`、\`/effort high\`。不带参数会弹出选择框，Discord 里点不了。`);
    }
    await react(s.threadId, ev.message_id, "👀");
    return enqueue(s.threadId, () => runLocalCommand(s, ev, text));
  }
  return postMessage(
    s.threadId,
    `\`${cmd}\` 是交互式界面或者暂不支持，Discord 里没法操作，请到 dinotty 的 cc-bridge 标签页里用（可以先发 \`/screen\` 看看终端现在的样子）。发 \`/help\` 看支持的指令。`
  );
}

// ---------- 主循环 ----------

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const inbox = await readCompleteLines(INBOX_FILE);
    for (const line of inbox.slice(state.inboxLines)) {
      state.inboxLines++;
      await saveState();
      try {
        const ev = JSON.parse(line);
        if (ev.type === "message") await handleMessage(ev);
      } catch (e) {
        console.error("[inbox] 处理出错:", e.message);
      }
    }
  } finally {
    ticking = false;
  }
}

// 开机时网络可能还没好，标签初始化失败就隔一会儿重试
for (;;) {
  try {
    await ensureTags();
    break;
  } catch (e) {
    console.error("[forum] 初始化标签失败，10 秒后重试:", e.message);
    await sleep(10000);
  }
}
await saveState();
startApiServer();
console.log(`[discord_bridge] 启动，会话 ${Object.keys(state.sessions).length} 个，inbox 从第 ${state.inboxLines} 行开始`);
setInterval(() => tick().catch((e) => console.error("[tick]", e.message)), POLL_MS);
