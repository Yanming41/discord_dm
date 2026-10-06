// discord_bridge.mjs
//
// Discord 论坛帖子 ↔ Claude Code 桥接。一个帖子 = 一个 Claude Code 会话 = 一个 dinotty pane。
//
// 主频道：  /cc 标题   开一个新会话(论坛里新建帖子 + dinotty 里新开一个跑 claude 的标签页)
//           /list      看当前会话      /help  看用法
// 帖子里：  直接发消息 → 转给这个帖子的 Claude
//           /stop      中止 Claude 当前的任务(相当于按 Esc)
//           /end       结束会话，关掉对应的终端
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

import { readFile, writeFile, rename, open, mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
const CC_CWD = HOME;
const TRANSCRIPT_DIR = path.join(HOME, ".claude", "projects", CC_CWD.replace(/[^a-zA-Z0-9]/g, "-"));
const MAX_SESSIONS = 4;
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

function newSession(threadId, title) {
  return { threadId, title, claudeSessionId: randomUUID(), tabId: null, paneId: null, paneToken: null, paneTokenId: null, busy: false };
}

const state = await loadState();
for (const s of Object.values(state.sessions)) s.busy = false;
const saveState = () => writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");

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

async function postLong(channelId, text) {
  for (const chunk of splitForDiscord(text)) await postMessage(channelId, chunk);
}

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

const transcriptPath = (s) => path.join(TRANSCRIPT_DIR, `${s.claudeSessionId}.jsonl`);

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
    cwd: CC_CWD.replace(/\\/g, "/"),
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
    if (hasInputPrompt(lines)) return;
  }
  throw new Error("Claude Code 终端 90 秒内没有进入输入状态，去 dinotty 看一下");
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
    await postLong(s.threadId, texts.join("\n\n") || "(Claude 这轮没有文字回复)");
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

const HELP = [
  "**Claude Code 桥接用法**",
  "主频道：`/cc 标题` 开新会话 · `/list` 看会话 · `/help` 帮助",
  "会话帖子里：直接发消息就是跟 Claude 说话 · `/stop` 中止当前任务 · `/end` 结束会话并关掉终端",
  "状态：👀 收到 → ⏳ 处理中 → ✅ 完成 / ❌ 出错，处理期间有一条进度消息实时刷新。",
].join("\n");

async function createSession(title) {
  const active = Object.keys(state.sessions).length;
  if (active >= MAX_SESSIONS) {
    await postMessage(DISCORD_CHANNEL_ID, `最多同时 ${MAX_SESSIONS} 个会话，先在不用的帖子里发 \`/end\` 关掉一个。`, { asClaude: false });
    return;
  }
  const thread = await discord("POST", `/channels/${DISCORD_FORUM_CHANNEL_ID}/threads`, {
    name: `[cc] ${title}`.slice(0, 100),
    message: { content: "Claude Code 会话。终端启动中，好了会在这里说一声。\n" + HELP.split("\n").slice(2).join("\n") },
    applied_tags: [tagIds[TAG_AGENT], tagIds[TAG_IDLE]].filter(Boolean),
  });
  const s = newSession(thread.id, title);
  state.sessions[thread.id] = s;
  await saveState();
  await postMessage(DISCORD_CHANNEL_ID, `已开会话 <#${thread.id}>`, { asClaude: false });
  enqueue(thread.id, async () => {
    try {
      await ensurePane(s);
      await saveState();
      await postMessage(thread.id, "🟢 Claude Code 已就绪，直接发消息吧。");
    } catch (e) {
      await postMessage(thread.id, `❌ 终端启动失败：${e.message}`);
    }
  });
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
  await postMessage(s.threadId, "会话已结束，终端已关闭。想继续的话在主频道重新 `/cc`。");
  await quietly(discord("PATCH", `/channels/${s.threadId}`, { applied_tags: [tagIds[TAG_AGENT], tagIds[TAG_DONE]].filter(Boolean) }, { maxRetryWaitMs: 3000 }), "标签");
}

async function handleMessage(ev) {
  if (ev.author_id !== DISCORD_OWNER_ID) return;
  const text = ev.content.trim();

  if (ev.thread_id) {
    const s = state.sessions[ev.thread_id];
    if (!s) return;
    if (text === "/stop") return stopSession(s);
    if (text === "/end") return enqueue(s.threadId, () => endSession(s));
    if (!text) return;
    await react(s.threadId, ev.message_id, "👀");
    enqueue(s.threadId, () => runTurn(s, ev));
    return;
  }

  if (ev.channel_id !== DISCORD_CHANNEL_ID) return;
  const m = text.match(/^\/cc(?:\s+(.+))?$/s);
  if (m) return createSession((m[1] || "未命名").trim());
  if (text === "/list") return listSessions();
  if (text === "/help") return postMessage(DISCORD_CHANNEL_ID, HELP, { asClaude: false });
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
console.log(`[discord_bridge] 启动，会话 ${Object.keys(state.sessions).length} 个，inbox 从第 ${state.inboxLines} 行开始`);
setInterval(() => tick().catch((e) => console.error("[tick]", e.message)), POLL_MS);
