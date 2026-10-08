// tars_watch.mjs
//
// tars-pilot 的 Discord 播报员。盯着 tars-pilot(127.0.0.1:8765)的任务队列，不管是谁调用的
// (2B、小红书脚本、命令行…)，都在「网页操作」频道里以 tars-pilot 的身份播报：
//   收到任务 → 一张卡片，执行中原地刷新(第几步、当前进度、最近动作) → 结束时变成结果
// Duo 匹配码这类要用户马上处理的通知([通知] 开头的日志行)单独发一条并 @ 用户，手机会响。
//
// 频道和 webhook 第一次运行时自动创建，记在 ~/.discord_dm/tars_watch_state.json。
// 由 discord_bridge.mjs 启动：startTarsWatch({ token, guildId, mainChannelId, ownerId })

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const TARS = "http://127.0.0.1:8765";
const STATE_FILE = path.join(os.homedir(), ".discord_dm", "tars_watch_state.json");
const CHANNEL_NAME = "网页操作";
const POLL_MS = 3000;
const EDIT_MS = 5000;
const DEFAULT_MAX_STEPS = 25;
const KEEP_RUNS = 200;
const NO_MENTIONS = { parse: [] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒`;
}

const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}…` : t);
const plain = (t) => String(t ?? "").replace(/`/g, "'").replace(/\s+/g, " ").trim();

// ---------- 从 tars-pilot 的日志里读出进度 ----------

function parseLog(log) {
  const lines = (Array.isArray(log) ? log : []).map((l) => (typeof l === "string" ? l : JSON.stringify(l)));
  const info = { step: 0, totalSteps: null, progress: null, actions: [], notices: [], modelStarting: false };
  for (const raw of lines) {
    for (const line of raw.split("\n")) {
      const t = line.trim();
      let m;
      if ((m = t.match(/^\[step (\d+)\/(\d+)\]/))) {
        info.step = Number(m[1]);
        info.totalSteps = Number(m[2]);
        info.actions.push(t.replace(/^\[step \d+\/\d+\]\s*\(\+[\d.]+s\)\s*/, ""));
      } else if ((m = t.match(/^\[GPT step (\d+)\]/))) {
        info.step = Number(m[1]);
        info.totalSteps = null; // 模板回放失败后交给 GPT 兜底，总步数不再确定
      } else if ((m = t.match(/^进度[:：]\s*(.+)/))) {
        info.progress = m[1];
      } else if ((m = t.match(/^动作[:：]\s*(.+)/))) {
        info.actions.push(m[1].replace(/\s*→\s*定位.*$/, ""));
      } else if ((m = t.match(/^\[通知\]\s*(.+)/))) {
        info.notices.push(m[1]);
      } else if (t.startsWith("[model] 启动")) {
        info.modelStarting = true;
      } else if (t.startsWith("[model] 模型就绪")) {
        info.modelStarting = false;
      }
    }
  }
  return info;
}

function describeTask(req) {
  if (req.recipe) {
    const vars = req.vars && Object.keys(req.vars).length ? ` ${JSON.stringify(req.vars)}` : "";
    return `模板 \`${req.recipe}\`${vars}`;
  }
  return clip(plain(req.task || "(没有描述)"), 300);
}

function renderCard(run) {
  const req = run.request ?? {};
  const info = parseLog(run.log);
  const head = [
    `🖱️ **网页任务** · \`${String(run.id).slice(0, 8)}\`${req.caller ? ` · 来自 ${req.caller}` : ""}`,
    `**任务**：${describeTask(req)}`,
    `**网站**：${req.browser || "chrome"} · ${req.cdp || "当前标签页"}`,
  ];
  const startedAt = Date.parse(run.startedAt || run.createdAt || "") || Date.now();

  if (run.status === "queued") {
    return [...head, "🕒 排队中：前面还有任务(鼠标键盘只有一套，只能一个个来)"].join("\n");
  }
  if (run.status === "running") {
    const max = info.totalSteps ?? req.maxSteps ?? DEFAULT_MAX_STEPS;
    const stepText = info.step ? (info.totalSteps ? `第 ${info.step}/${max} 步` : `第 ${info.step} 步(最多 ${max} 步)`) : "准备中";
    const lines = [...head, `⏳ 进行中 · ${stepText} · 已用 ${formatElapsed(Date.now() - startedAt)}`];
    if (info.modelStarting && !info.step) lines.push("正在启动本地视觉模型，第一次要 1-2 分钟…");
    if (info.progress) lines.push(`**进度**：${clip(plain(info.progress), 200)}`);
    const recent = info.actions.slice(-3).map((a) => `• \`${clip(plain(a), 90)}\``);
    if (recent.length) lines.push(...recent);
    return lines.join("\n");
  }

  const result = run.result ?? {};
  const took = formatElapsed(result.durationMs ?? Date.now() - startedAt);
  const steps = result.steps ?? info.step;
  const answer = clip(plain(result.answer || result.reason || ""), 600);
  if (run.status === "done") {
    return [...head, `✅ 完成 · 用时 ${took} · 共 ${steps} 步`, answer && `**结果**：${answer}`].filter(Boolean).join("\n");
  }
  if (run.status === "cancelled") {
    return [...head, `⏹ 已取消 · 用时 ${took}`, answer && `**说明**：${answer}`].filter(Boolean).join("\n");
  }
  return [...head, `❌ 没完成 · 用时 ${took}${steps ? ` · 停在第 ${steps} 步` : ""}`, answer && `**原因**：${answer}`].filter(Boolean).join("\n");
}

const isActive = (status) => status === "queued" || status === "running";

// ---------- Discord ----------

export async function startTarsWatch({ token, guildId, mainChannelId, ownerId }) {
  const api = async (method, route, body) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`https://discord.com/api/v10${route}`, {
        method,
        headers: { Authorization: `Bot ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429) {
        await sleep(((await res.json().catch(() => ({}))).retry_after ?? 1) * 1000 + 100);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`${method} ${route} -> HTTP ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
      return text ? JSON.parse(text) : null;
    }
    throw new Error("Discord 多次限流");
  };

  const state = existsSync(STATE_FILE) ? JSON.parse(await readFile(STATE_FILE, "utf-8")) : { channelId: null, webhookUrl: null, runs: {}, primed: false };
  const save = () => writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");

  // 频道：先看记下的还在不在，再按名字找，都没有就建在主频道同一个分类下
  async function ensureChannel() {
    if (state.channelId) {
      const ok = await api("GET", `/channels/${state.channelId}`).catch(() => null);
      if (ok) return;
      state.webhookUrl = null;
    }
    const channels = await api("GET", `/guilds/${guildId}/channels`);
    let ch = channels.find((c) => c.type === 0 && c.name === CHANNEL_NAME);
    if (!ch) {
      const parent = channels.find((c) => c.id === mainChannelId)?.parent_id ?? undefined;
      ch = await api("POST", `/guilds/${guildId}/channels`, {
        name: CHANNEL_NAME,
        type: 0,
        parent_id: parent,
        topic: "tars-pilot 的任务播报：谁调用了网页操作、每一步进度、结果。Duo 匹配码会在这里 @ 你。",
      });
    }
    state.channelId = ch.id;
  }

  async function ensureWebhook() {
    if (state.webhookUrl) return;
    const hook = await api("POST", `/channels/${state.channelId}/webhooks`, { name: "tars-pilot" });
    state.webhookUrl = `https://discord.com/api/webhooks/${hook.id}/${hook.token}`;
  }

  const hookPost = async (content, allowed = NO_MENTIONS) => {
    const res = await fetch(`${state.webhookUrl}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: allowed }),
    });
    if (!res.ok) throw new Error(`webhook 发送失败 HTTP ${res.status}`);
    return res.json();
  };
  const hookEdit = async (messageId, content) => {
    const res = await fetch(`${state.webhookUrl}/messages/${messageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: NO_MENTIONS }),
    });
    if (!res.ok) throw new Error(`webhook 编辑失败 HTTP ${res.status}`);
  };

  const tars = async (route) => {
    const res = await fetch(`${TARS}${route}`);
    if (!res.ok) throw new Error(`tars-pilot HTTP ${res.status}`);
    return res.json();
  };
  const listRuns = async () => {
    const r = await tars("/runs");
    return Array.isArray(r) ? r : r.runs ?? [];
  };

  for (;;) {
    try {
      await ensureChannel();
      await ensureWebhook();
      // 第一次运行：已有的历史任务不播报，只播报之后新来的
      if (!state.primed) {
        const existing = await listRuns().catch(() => []);
        for (const r of existing) if (!isActive(r.status)) state.runs[r.id] = { done: true };
        state.primed = true;
      }
      await save();
      break;
    } catch (e) {
      console.error("[tars-watch] 初始化失败，30 秒后重试:", e.message);
      await sleep(30000);
    }
  }
  console.log(`[tars-watch] 在 #${CHANNEL_NAME} 播报 tars-pilot 的任务`);

  let lastErrorLog = 0;
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const runs = await listRuns();
      for (const summary of runs) {
        const rec = state.runs[summary.id] ?? (state.runs[summary.id] = {});
        if (rec.done) continue;
        const run = isActive(summary.status) || !summary.log ? await tars(`/runs/${summary.id}`) : summary;
        const card = renderCard(run);

        if (!rec.messageId) {
          rec.messageId = (await hookPost(card)).id;
          rec.lastCard = card;
          rec.lastEdit = Date.now();
        } else if (card !== rec.lastCard && (!isActive(run.status) || Date.now() - rec.lastEdit >= EDIT_MS)) {
          await hookEdit(rec.messageId, card);
          rec.lastCard = card;
          rec.lastEdit = Date.now();
        }

        const notices = parseLog(run.log).notices;
        rec.noticesSent ??= 0;
        for (const n of notices.slice(rec.noticesSent)) {
          await hookPost(`🔔 <@${ownerId}> 网页任务 \`${String(run.id).slice(0, 8)}\` 需要你：${n}`, { users: [ownerId] });
        }
        rec.noticesSent = notices.length;

        if (!isActive(run.status)) rec.done = true;
      }
      // 只留最近的记录，免得状态文件越来越大
      const ids = Object.keys(state.runs);
      if (ids.length > KEEP_RUNS) for (const id of ids.slice(0, ids.length - KEEP_RUNS)) delete state.runs[id];
      await save();
    } catch (e) {
      // tars-pilot 没开的时候每次都会失败，别刷屏
      if (Date.now() - lastErrorLog > 10 * 60 * 1000) {
        console.error("[tars-watch]", e.message);
        lastErrorLog = Date.now();
      }
    } finally {
      ticking = false;
    }
  }
  setInterval(tick, POLL_MS);
}

export { renderCard, parseLog };
