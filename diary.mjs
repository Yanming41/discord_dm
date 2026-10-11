// diary.mjs
//
// 2B 的每日日记(史官)：收集 zym 当天在 Discord 主频道/论坛帖子里的对话、各项目的 git 提交、
// 终端里直接开的 Claude Code 会话，交给 2B(pi -p，跟桥接里同一套提示词和长期记忆)写成一篇日记，
// 存到 ~/.discord_dm/diary/YYYY-MM-DD.md，再由 bot(2B)发到主频道。
//
// 由 Windows 计划任务每晚跑一次；6 点前跑(比如电脑睡着、醒来补跑)算前一天。
//   node diary.mjs             写今天(或凌晨补写昨天)
//   node diary.mjs 2026-10-09  补写指定日期
//   node diary.mjs --dry       只打印收集到的素材，不调用 2B、不发消息

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./load_env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const DATA_DIR = path.join(HOME, ".discord_dm");
const DIARY_DIR = path.join(DATA_DIR, "diary");
const PI_CLI = path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const REPO_ROOTS = [path.join(HOME, "IdeaProjects"), HOME]; // 第二个只看 HOME 下直接的仓库(ui-tars-local 等)
const CLAUDE_PROJECTS = path.join(HOME, ".claude", "projects");
const MATERIAL_LIMIT = 60000; // 素材总字数上限，超了就截短每条消息

const env = await loadEnv();
const { DISCORD_TOKEN, DISCORD_CHANNEL_ID, DISCORD_GUILD_ID, DISCORD_FORUM_CHANNEL_ID, DISCORD_OWNER_ID } = env;
const args = process.argv.slice(2);
const DRY = args.includes("--dry");

// ---------- 哪一天 ----------
function pickDay() {
  const given = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const d = given ? new Date(`${given}T12:00:00`) : new Date();
  if (!given && d.getHours() < 6) d.setDate(d.getDate() - 1);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  const label = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
  return { start, end, label };
}
const DAY = pickDay();
const inDay = (t) => t >= DAY.start && t < DAY.end;
const hhmm = (t) => t.toTimeString().slice(0, 5);

// ---------- Discord ----------
async function discord(method, route, body) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`https://discord.com/api/v10${route}`, {
      method,
      headers: { Authorization: `Bot ${DISCORD_TOKEN}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) {
      const wait = ((await r.json()).retry_after ?? 1) * 1000;
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    if (!r.ok) throw new Error(`Discord ${method} ${route} → ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  }
  throw new Error(`Discord ${route} 一直限流`);
}

// Discord 消息 ID(snowflake)里带时间，用它从当天 0 点之后开始往后翻
const snowflakeAt = (t) => ((BigInt(t.getTime()) - 1420070400000n) << 22n).toString();

async function messagesOfDay(channelId) {
  const out = [];
  let after = snowflakeAt(DAY.start);
  for (;;) {
    const batch = await discord("GET", `/channels/${channelId}/messages?limit=100&after=${after}`);
    if (!batch.length) break;
    batch.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    for (const m of batch) if (inDay(new Date(m.timestamp))) out.push(m);
    after = batch[batch.length - 1].id;
    if (new Date(batch[batch.length - 1].timestamp) >= DAY.end || batch.length < 100) break;
  }
  return out;
}

let BOT_ID = null;
function who(m) {
  if (m.author.id === DISCORD_OWNER_ID) return "zym";
  if (m.webhook_id) return m.author.username || "webhook";
  if (m.author.id === BOT_ID) return "2B/bot";
  return m.author.username;
}

function render(m, cut) {
  let body = m.content || "";
  if (!body && m.embeds?.length) body = `[卡片] ${m.embeds.map((e) => e.title || e.description || "").join(" / ")}`;
  if (m.attachments?.length) body += ` [附件 ${m.attachments.length}]`;
  body = body.replace(/\s+/g, " ").trim();
  if (body.length > cut) body = body.slice(0, cut) + "…";
  return body ? `${hhmm(new Date(m.timestamp))} ${who(m)}: ${body}` : null;
}

async function discordMaterial(cut) {
  const parts = [];
  const main = await messagesOfDay(DISCORD_CHANNEL_ID);
  // 自动推送的卡片(家具监控等)只数数量，不逐条列
  const cards = main.filter((m) => m.author.id !== DISCORD_OWNER_ID && !m.content && m.embeds?.length);
  const cardSenders = {};
  for (const m of cards) {
    const k = m.embeds[0]?.footer?.text || m.author.username;
    cardSenders[k] = (cardSenders[k] || 0) + 1;
  }
  const talk = main.filter((m) => !cards.includes(m)).map((m) => render(m, cut)).filter(Boolean);
  parts.push(`## 主频道(常规)\n${talk.join("\n") || "(当天没有对话)"}`);
  if (cards.length) parts.push(`## 主频道自动推送卡片数量\n${Object.entries(cardSenders).map(([k, n]) => `- ${k}: ${n} 条`).join("\n")}`);

  // 论坛帖子：活跃的 + 最近归档的，只要当天有消息的
  const threads = new Map();
  const active = await discord("GET", `/guilds/${DISCORD_GUILD_ID}/threads/active`).catch(() => ({ threads: [] }));
  for (const t of active.threads || []) if (t.parent_id === DISCORD_FORUM_CHANNEL_ID) threads.set(t.id, t);
  const archived = await discord("GET", `/channels/${DISCORD_FORUM_CHANNEL_ID}/threads/archived/public?limit=50`).catch(() => ({ threads: [] }));
  for (const t of archived.threads || []) threads.set(t.id, t);
  for (const t of threads.values()) {
    const last = t.last_message_id ? new Date(Number((BigInt(t.last_message_id) >> 22n) + 1420070400000n)) : null;
    if (last && last < DAY.start) continue;
    const msgs = await messagesOfDay(t.id).catch(() => []);
    const lines = msgs.map((m) => render(m, cut)).filter(Boolean);
    if (lines.length) parts.push(`## 帖子「${t.name}」\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

// ---------- git 提交 ----------
async function listRepos() {
  const repos = new Set();
  for (const root of REPO_ROOTS) {
    if (!existsSync(root)) continue;
    for (const name of await readdir(root)) {
      const dir = path.join(root, name);
      if (existsSync(path.join(dir, ".git"))) repos.add(dir);
    }
  }
  return [...repos];
}

async function gitMaterial() {
  const since = DAY.start.toISOString();
  const until = DAY.end.toISOString();
  const parts = [];
  for (const repo of await listRepos()) {
    try {
      const log = execFileSync("git", ["-C", repo, "log", "--all", `--since=${since}`, `--until=${until}`, "--format=%ad %s", "--date=format:%H:%M"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (log) parts.push(`## ${path.basename(repo)}\n${log}`);
    } catch {}
  }
  return parts.join("\n\n") || "(当天没有提交)";
}

// ---------- 终端里的 Claude Code 会话(只取 zym 说的话，Discord 桥接开的会话上面已经有了) ----------
async function claudeMaterial(cut) {
  if (!existsSync(CLAUDE_PROJECTS)) return "";
  const parts = [];
  for (const proj of await readdir(CLAUDE_PROJECTS)) {
    const dir = path.join(CLAUDE_PROJECTS, proj);
    let files;
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      const st = await stat(file);
      if (st.mtime < DAY.start) continue;
      const said = [];
      for (const line of (await readFile(file, "utf-8")).split("\n")) {
        if (!line.includes('"type":"user"')) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o.type !== "user" || o.isMeta || !o.timestamp || !inDay(new Date(o.timestamp))) continue;
        const c = o.message?.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text).join(" ") : "";
        // 跳过工具结果、系统注入和桥接转发进来的消息
        if (!text || text.startsWith("<") || text.includes("[来自 Discord")) continue;
        said.push(`${hhmm(new Date(o.timestamp))} ${text.replace(/\s+/g, " ").slice(0, cut)}`);
      }
      if (said.length) parts.push(`## 会话 ${proj} / ${f.slice(0, 8)}\n${said.join("\n")}`);
    }
  }
  return parts.join("\n\n");
}

// ---------- 待办 ----------
function todoMaterial() {
  try {
    return execFileSync("cmd", ["/c", "todo", "ls"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    return `(读不到待办：${String(e.stderr || e.message).trim().slice(0, 150)})`;
  }
}

// ---------- 让 2B 写 ----------
function runPi(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        PI_CLI, "-p", "--no-session", "--no-extensions", "--no-context-files",
        "--append-system-prompt", path.join(__dirname, "2b_prompt.md"),
        "--append-system-prompt", path.join(DATA_DIR, "2b_memory.md"),
      ],
      { cwd: HOME, windowsHide: true }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), 15 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error((err || out).trim().slice(-400) || `pi 退出码 ${code}`));
    });
    child.stdin.end(prompt);
  });
}

const INSTRUCTIONS = (label) => `现在是你写日记的时间。你是 zym 的书记员/史官，把他 ${label} 这一天做了什么如实记下来，方便他以后回头查找。下面是系统收集到的当天素材。

要求：
- 用第三人称、按事情归类写，不要流水账照抄聊天记录。写清楚：今天推进了哪些项目、各自做到哪一步；开发/改了什么软件和功能；学习/课程上做了什么；生活上的事；自动推送(如小红书家具推荐)有多少条、zym 有没有感兴趣的。
- 只写素材里有的事，不要编造，不确定就不写。帖子标题和项目名照原样写，方便以后搜索。
- 素材很少就写短一点，没什么事就一两句话。
- 如果素材里看得出 zym 当天的状态和心情(累、烦、开心、焦虑…)，写一节「## 今天的状态」，如实简短地记，不要说教、不要强行开导；看不出来就不写。
- 最后写一节「## 2B 的想法」：大胆提优化建议和你的看法，比如哪里在浪费算力/token(重复调用、该用命令行却用了 tars、同一件事反复做)、哪里有重复或闲置的资源、哪个流程可以省事、他的做法或设计哪里可以改进。要具体、说清理由。确实没什么可说的就不写这一节。想改你自己的提示词属于 L3，只能在这里提议，不要动手。
- 待办：提一下快到期或已过期的；拖了很久没动的可以在「2B 的想法」里提醒。
- 如果有值得长期记住的(偏好、交代的事、正在跟进的事)，可以顺手更新 2b_memory.md(L1)。
- 直接输出日记正文(Markdown)，第一行是「# ${label} 日记」，不要加任何前后说明。

`;

async function postToMain(text) {
  const chunks = [];
  let rest = text;
  while (rest.length > 1900) {
    let cut = rest.lastIndexOf("\n", 1900);
    if (cut < 500) cut = 1900;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  for (const c of chunks) await discord("POST", `/channels/${DISCORD_CHANNEL_ID}/messages`, { content: c, allowed_mentions: { parse: [] } });
}

async function main() {
  BOT_ID = (await discord("GET", "/users/@me")).id;
  let cut = 400;
  let material;
  const todos = todoMaterial(); // 放在截断循环外，只读一次
  for (;;) {
    const [dc, git, cc] = await Promise.all([discordMaterial(cut), gitMaterial(), claudeMaterial(cut)]);
    material = `# Discord\n${dc}\n\n# 当天的 git 提交\n${git}\n\n# 终端里直接用 Claude Code 时 zym 说的话\n${cc || "(没有)"}\n\n# 当前待办(Microsoft To Do，未完成的)\n${todos}`;
    if (material.length <= MATERIAL_LIMIT || cut <= 80) break;
    cut = Math.floor(cut / 2);
  }
  if (material.length > MATERIAL_LIMIT) material = material.slice(0, MATERIAL_LIMIT) + "\n…(素材太长，后面截掉了)";
  if (DRY) {
    console.log(material);
    return;
  }
  const diary = await runPi(INSTRUCTIONS(DAY.label) + material);
  await mkdir(DIARY_DIR, { recursive: true });
  const file = path.join(DIARY_DIR, `${DAY.label}.md`);
  await writeFile(file, diary + "\n", "utf-8");
  console.log(`已写入 ${file}`);
  await postToMain(`📔 ${diary}`);
}

main().catch((e) => {
  console.error("[diary]", e.message);
  process.exit(1);
});
