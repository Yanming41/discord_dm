// discord_bridge.mjs
//
// 把一个 Discord 论坛帖子里 owner 本人的消息转进一个 Claude Code pane（dinotty），
// 再把 Claude 的回复写回这个帖子。只操作一个 pane，且只用 dinotty 的 Agent Token 访问，
// 这个 token 的 scope 只包含该 pane 的 terminal:read / terminal:write。
//
// 前提：discord_dm.mjs 在跑（负责收发 Discord 消息），dinotty 在跑且 open_api 已开启，
// 并且 ~/.discord_dm/dinotty_agent_token 里有上面那个 pane 的 Agent Token。
// 必须配置 DISCORD_OWNER_ID，否则拒绝启动。

import { readFile, appendFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./load_env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INBOX_FILE = path.join(__dirname, "inbox.jsonl");
const OUTBOX_FILE = path.join(__dirname, "outbox.jsonl");
const STATE_FILE = path.join(__dirname, "bridge_state.json");
const TOKEN_FILE = path.join(os.homedir(), ".discord_dm", "dinotty_agent_token");

const DINOTTY = "http://127.0.0.1:8999";
const CC_PANE_ID = "4fd6f661-56f2-4a23-9ebe-06a97aaf9179";
const POLL_MS = 2000;
const REPLY_TIMEOUT_MS = 5 * 60 * 1000;
const CHUNK = 1800;

const fileEnv = await loadEnv();
const env = { ...fileEnv, ...process.env };
const { DISCORD_CHANNEL_ID, DISCORD_FORUM_CHANNEL_ID, DISCORD_OWNER_ID } = env;
if (!DISCORD_CHANNEL_ID || !DISCORD_FORUM_CHANNEL_ID) {
  throw new Error("缺 .env 配置：需要 DISCORD_CHANNEL_ID 和 DISCORD_FORUM_CHANNEL_ID");
}
if (!DISCORD_OWNER_ID) {
  throw new Error("未配置 DISCORD_OWNER_ID，拒绝启动（桥接会把消息转进 Claude Code，必须限定只有本人能发）");
}
if (!existsSync(TOKEN_FILE)) {
  throw new Error(`找不到 dinotty Agent Token: ${TOKEN_FILE}`);
}
const AGENT_TOKEN = (await readFile(TOKEN_FILE, "utf-8")).trim();

async function readCompleteLines(file) {
  if (!existsSync(file)) return [];
  const parts = (await readFile(file, "utf-8")).split("\n");
  parts.pop();
  return parts.filter(Boolean);
}

let state = existsSync(STATE_FILE)
  ? JSON.parse(await readFile(STATE_FILE, "utf-8"))
  : { inboxLines: (await readCompleteLines(INBOX_FILE)).length, threadId: null, pendingRef: null };
const saveState = () => writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");

async function outbox(entry) {
  await appendFile(OUTBOX_FILE, JSON.stringify(entry) + "\n", "utf-8");
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

async function postToThread(text) {
  for (const chunk of splitForDiscord(text || "(无输出)")) {
    await outbox({ thread_id: state.threadId, text: chunk });
  }
}

// ---------- dinotty Agent API（只访问 CC_PANE_ID）----------

async function dinottyFetch(method, urlPath, body) {
  const res = await fetch(`${DINOTTY}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${AGENT_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`dinotty ${method} ${urlPath} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function readPane() {
  const r = await dinottyFetch("GET", `/api/sessions/${CC_PANE_ID}/read?pane_id=${CC_PANE_ID}`);
  return r.lines.map((l) => l.replace(/\s+$/, ""));
}

async function sendToPane(text) {
  // 多行会被 Claude 当成多次提交，统一压成一行；末尾 \r 才会提交输入框
  const oneLine = text.replace(/\r?\n/g, " ").trim();
  await dinottyFetch("POST", `/api/sessions/${CC_PANE_ID}/send`, { pane_id: CC_PANE_ID, command: `${oneLine}\r` });
}

// dinotty 的 read 会把中文字符之间塞空格，这里还原
function fixCjkSpacing(s) {
  return s.replace(/(?<=[　-鿿＀-￯])\s+(?=[　-鿿＀-￯])/g, "");
}

const isBusy = (lines) => lines.some((l) => /esc to interrupt|Working|Thinking|✶/i.test(l));
const isIdlePrompt = (lines) => lines.some((l) => /^❯\s*$/.test(l.trim()) || /^❯ Try "/.test(l.trim()));
const replyMarkers = (lines) => lines.filter((l) => l.startsWith("● ")).length;

function extractLastReply(lines) {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("● ")) {
      start = i;
      break;
    }
  }
  if (start === -1) return "";
  const body = [lines[start].slice(2)];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("✻") || /^─+$/.test(l.trim()) || l.startsWith("❯")) break;
    body.push(l.replace(/^ {2}/, ""));
  }
  return fixCjkSpacing(body.join("\n")).trim();
}

// ---------- 一轮对话：发出去 → 等 Claude 答完 → 读回复 ----------

async function runTurn(prompt) {
  const before = replyMarkers(await readPane());
  await sendToPane(prompt);
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  let sawNewReply = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const lines = await readPane();
    if (!sawNewReply && replyMarkers(lines) > before) sawNewReply = true;
    if (sawNewReply && !isBusy(lines) && isIdlePrompt(lines)) {
      return extractLastReply(lines) || "(Claude 没有文字回复)";
    }
  }
  return "⚠️ 等待 Claude 回复超时（5 分钟）。可以去 dinotty 里看一下 cc-bridge 的状态。";
}

const queue = { tail: Promise.resolve() };
function enqueue(job) {
  queue.tail = queue.tail.then(job).catch((e) => console.error("[队列] 出错:", e.message));
}

// ---------- Discord 事件处理 ----------

function handleMessage(ev) {
  if (ev.author_id !== DISCORD_OWNER_ID) return;

  if (ev.thread_id && ev.thread_id === state.threadId) {
    enqueue(async () => {
      let reply;
      try {
        reply = await runTurn(ev.content);
      } catch (e) {
        reply = `⚠️ 桥接出错: ${e.message}`;
      }
      await postToThread(reply);
      await saveState();
    });
    return;
  }

  if (ev.channel_id === DISCORD_CHANNEL_ID && ev.content.trim() === "/status") {
    outbox({
      text: `桥接运行中 | 绑定帖子: ${state.threadId ? `<#${state.threadId}>` : "尚未创建"} | 目标 pane: ${CC_PANE_ID}`,
    });
  }
}

async function handleInbox(ev) {
  if (ev.type === "forum_post_created" && ev.ref === state.pendingRef) {
    state.threadId = ev.thread_id;
    state.pendingRef = null;
    await saveState();
    await outbox({ text: `Claude Code 桥接已就绪，在 <#${state.threadId}> 里直接发消息即可。` });
    return;
  }
  if (ev.type === "message") handleMessage(ev);
}

async function ensureThread() {
  if (state.threadId || state.pendingRef) return;
  state.pendingRef = randomUUID();
  await saveState();
  await outbox({
    new_forum_post: {
      title: "[cc] cc-bridge 会话",
      text: "这里是 Claude Code（cc-bridge pane）的桥接会话。在这个帖子里发消息，会转给 Claude Code，回复会回到这里。",
      status_tag: "进行中",
      ref: state.pendingRef,
    },
  });
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const inbox = await readCompleteLines(INBOX_FILE);
    for (const line of inbox.slice(state.inboxLines)) {
      try {
        await handleInbox(JSON.parse(line));
      } catch (e) {
        console.error("[inbox] 处理出错:", e.message);
      }
      state.inboxLines++;
      await saveState();
    }
  } finally {
    ticking = false;
  }
}

console.log(`[discord_bridge] 启动，目标 pane=${CC_PANE_ID}，inbox 从第 ${state.inboxLines} 行开始`);
await ensureThread();
setInterval(() => tick().catch((e) => console.error("[tick]", e.message)), POLL_MS);
