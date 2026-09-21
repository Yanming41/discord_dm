// discord_dm.mjs
//
// 纯传输层——只负责往Discord发消息/收按钮点击，不含任何"这条消息该长什么样、点了按钮该
// 回什么"的业务逻辑。跟wx_dm.mjs一个设计思路(见 ~/IdeaProjects/wx_dm)：外部程序靠两个
// 文件跟这个脚本通信，不需要知道discord.js的任何细节。
//
// 对外接口是两个文件(本目录下)：
//   outbox.jsonl  外部程序写，本脚本读 —— 想发的消息，一行JSON
//   inbox.jsonl   本脚本写，外部程序读 —— 收到的按钮点击事件，一行JSON
//
// outbox 一行的格式，三选一：
//
//   1) 纯文字：
//      {"sender":"小红书爬虫","text":"..."}
//
//   2) 富文本卡片(带图/按钮)：
//      {
//        "sender": "小红书爬虫",
//        "title": "...", "url": "https://...", "description": "...",
//        "colorTag": "match" | "unsure" | "highlight" | 不传,
//        "fields": [{"name":"判断依据","value":"..."}],
//        "images": ["本机文件路径1", "本机文件路径2"],  // 多张会被Discord自动排成图集
//        "buttons": [{"id":"interested_xxx","label":"感兴趣","style":"Success"},
//                     {"id":"skip_xxx","label":"跳过","style":"Secondary"}]
//      }
//
//   3) 回复一次之前的按钮点击(配合inbox.jsonl里收到的interaction信息用)：
//      {"reply_to_interaction": {"application_id":"...","token":"..."}, "text":"..."}
//
// inbox 一行格式(按钮被点击时)：
//   {
//     "type": "button_click", "custom_id": "interested_xxx",
//     "interaction": {"application_id":"...","token":"..."},  // 拿去构造上面第3种outbox写回复用
//     "ts": 1234567890
//   }
//   本脚本收到点击后会立刻deferReply(ephemeral)——Discord要求3秒内必须有响应，这一步跟
//   "点了按钮该回什么内容"是分开的，本脚本不知道也不关心该回什么，只负责占住这个交互、
//   把事件转发出去。外部程序看到inbox里的事件后，自己决定回复内容，写回outbox
//   (带上同一个interaction的application_id+token)，本脚本再用Discord的webhook消息编辑
//   接口把内容填进去——这个接口只需要token，不需要拿着原始的interaction对象，所以能跨
//   进程做这个"异步回复"。
//
// 用法：node discord_dm.mjs　(常驻运行，同一个终端窗口自带交互式控制台，输入help看命令列表)

import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} from "discord.js";
import { readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { loadEnv } from "./load_env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTBOX_FILE = path.join(__dirname, "outbox.jsonl");
const INBOX_FILE = path.join(__dirname, "inbox.jsonl");
const POLL_MS = 3000; // Discord没有微信那种"会话窗口"限制，不用像wx_dm那样费劲上fs.watch，轮询就够快了

const env = await loadEnv();
const { DISCORD_TOKEN, DISCORD_CHANNEL_ID } = env;
if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID) {
  throw new Error("缺 .env 配置，检查 DISCORD_TOKEN / DISCORD_CHANNEL_ID");
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions],
});

let channel = null;
let outboxLinesProcessed = 0;

// ---------- 运行统计(给交互式控制台的status命令用) ----------
const startedAt = Date.now();
const stats = { sent: 0, buttonClicks: 0, errors: 0 };

function colorFor(tag) {
  if (tag === "highlight") return 0x3498db;
  if (tag === "unsure") return 0xf1c40f;
  if (tag === "match") return 0x00b894;
  return 0x99aab5;
}

async function sendCard(entry) {
  const mainEmbed = new EmbedBuilder().setColor(colorFor(entry.colorTag)).setTimestamp();
  if (entry.title) mainEmbed.setTitle(entry.title.slice(0, 250));
  if (entry.url) mainEmbed.setURL(entry.url);
  if (entry.description) mainEmbed.setDescription(entry.description);
  if (entry.fields?.length) mainEmbed.addFields(entry.fields);
  if (entry.sender) mainEmbed.setFooter({ text: entry.sender });

  const files = [];
  const embeds = [mainEmbed];
  (entry.images || []).slice(0, 9).forEach((imgPath, i) => {
    if (!existsSync(imgPath)) return;
    const filename = `img${i}.jpg`;
    files.push(new AttachmentBuilder(imgPath, { name: filename }));
    if (i === 0) mainEmbed.setImage(`attachment://${filename}`);
    else {
      const extra = new EmbedBuilder().setImage(`attachment://${filename}`);
      if (entry.url) extra.setURL(entry.url);
      embeds.push(extra);
    }
  });

  const components = [];
  if (entry.buttons?.length) {
    const row = new ActionRowBuilder().addComponents(
      entry.buttons.map((b) =>
        new ButtonBuilder().setCustomId(b.id).setLabel(b.label).setStyle(ButtonStyle[b.style] ?? ButtonStyle.Secondary)
      )
    );
    components.push(row);
  }

  await channel.send({ embeds, components, files });
}

async function replyToInteraction(interactionRef, text) {
  const { application_id, token } = interactionRef;
  const res = await fetch(`https://discord.com/api/v10/webhooks/${application_id}/${token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: text }),
  });
  if (!res.ok) {
    console.error(`[回复交互] 失败 HTTP ${res.status}:`, await res.text());
  }
}

async function checkOutbox() {
  if (!existsSync(OUTBOX_FILE)) return;
  const content = await readFile(OUTBOX_FILE, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  if (lines.length <= outboxLinesProcessed) return;

  const newLines = lines.slice(outboxLinesProcessed);
  for (const line of newLines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      console.error("[outbox] 跳过一行无法解析的内容:", line);
      continue;
    }
    try {
      if (entry.reply_to_interaction) {
        await replyToInteraction(entry.reply_to_interaction, entry.text);
      } else if (entry.title || entry.images || entry.buttons) {
        await sendCard(entry);
      } else {
        await channel.send(entry.sender ? `**[${entry.sender}]**\n${entry.text}` : entry.text);
      }
      stats.sent++;
    } catch (e) {
      stats.errors++;
      console.error("[outbox] 发送出错:", e.message);
    }
  }
  outboxLinesProcessed = lines.length;
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  stats.buttonClicks++;
  // Discord要求3秒内必须响应交互——占住它，具体回什么内容是外部程序的事，
  // 这一步只负责"别让交互超时"，跟业务逻辑完全解耦。
  await interaction.deferReply({ ephemeral: true });
  await appendFile(
    INBOX_FILE,
    JSON.stringify({
      type: "button_click",
      custom_id: interaction.customId,
      interaction: { application_id: interaction.applicationId, token: interaction.token },
      ts: Date.now(),
    }) + "\n",
    "utf-8"
  );
});

// ---------- 交互式控制台：跟服务同一个进程/同一个终端，敲命令立刻生效 ----------

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}小时${m}分钟`;
}

function printHelp() {
  console.log(`可用命令：
  send <text>   立刻往频道发一条文字消息(带[控制台]标签)
  status        看运行状态(运行时长/发送数/收到的按钮点击数/出错数)
  help          看这份命令列表
  exit / quit   优雅退出(断开Discord连接再关进程)`);
}

async function handleCommand(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  const spaceIdx = trimmed.indexOf(" ");
  const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  switch (cmd) {
    case "send": {
      if (!rest) {
        console.log("用法: send <要发的文字>");
        break;
      }
      try {
        await channel.send(`**[控制台]**\n${rest}`);
        stats.sent++;
        console.log("已发送");
      } catch (e) {
        stats.errors++;
        console.error("发送失败:", e.message);
      }
      break;
    }
    case "status":
      console.log(
        `运行中 | 已连接 ${formatUptime(Date.now() - startedAt)} | 已发送 ${stats.sent} 条 | 收到 ${stats.buttonClicks} 次按钮点击 | 出错 ${stats.errors} 次`
      );
      break;
    case "help":
      printHelp();
      break;
    case "exit":
    case "quit":
      console.log("正在退出...");
      client.destroy();
      process.exit(0);
      break;
    default:
      console.log(`不认识的命令: "${cmd}"，输入 help 看看有哪些命令`);
  }
}

function startConsole() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  console.log('控制台已就绪，输入 help 看看有哪些命令。');
  rl.prompt();
  rl.on("line", async (line) => {
    await handleCommand(line).catch((e) => console.error("命令执行出错:", e.message));
    rl.prompt();
  });
  rl.on("close", () => {
    client.destroy();
    process.exit(0);
  });
}

client.once("clientReady", async () => {
  channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
  console.log(`[discord_dm] 已登录 ${client.user.tag}，频道已就绪`);
  setInterval(checkOutbox, POLL_MS);
  startConsole();
});

await client.login(DISCORD_TOKEN);
