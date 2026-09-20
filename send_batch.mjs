// send_batch.mjs
//
// 把之前给微信那批安省IKEA/地毯listing，改用Discord的embed+按钮格式重新发一遍，
// 方便对比效果。
//
// 分类这次改成多模态——把帖子的全部图片跟标题/正文一起丢给Gemini，让它自己看图
// 判断，而不是只看文字；顺便让它指出"哪张图片最适合拿来展示"(帖子经常打包卖多件
// 东西，比如IKEA家具混着婴儿车一起卖，只看文字选不出该展示哪张图，得让模型看完
// 全部图片自己挑)。这个套路照抄identify_model.mjs里selectRelevantImages那一步。
//
// 用法：node send_batch.mjs

import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} from "discord.js";
import { readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadEnv } from "./load_env.mjs";

const env = await loadEnv();
const ALL_CONTENTS_FILE = "../scooter-dm-helper/all_contents.jsonl";
const IMAGES_DIR = "../scooter-dm-helper/images";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL = "gemini-flash-lite-latest";
const MAX_IMAGES = 8; // 封顶8张，太多张一次性传给Gemini会拖慢+费token

const ONTARIO_PATTERN =
  /安省|密西沙加|Mississauga|多伦多|Toronto|万锦|Markham|士嘉堡|Scarborough|北约克|North ?York|列治文山|Richmond ?Hill|滑铁卢|Waterloo|渥太华|Ottawa|Ontario|GTA|大多伦多|dt自取/i;
const FURNITURE_KEYWORDS = ["二手家具", "回国出闲置", "搬家出闲置", "宜家二手", "ikea二手"];

// ---------- 拿到一条帖子的图片(优先本地已归档的，没有就带Referer头现下) ----------

async function loadNoteImages(note) {
  const localDir = path.join(IMAGES_DIR, note.note_id);
  if (existsSync(localDir)) {
    const files = readdirSync(localDir)
      .filter((f) => /^\d+\.jpg$/.test(f))
      .sort((a, b) => parseInt(a) - parseInt(b))
      .slice(0, MAX_IMAGES);
    const bufs = await Promise.all(files.map((f) => readFile(path.join(localDir, f))));
    return bufs;
  }

  const urls = (note.image_list?.split(",") || []).slice(0, MAX_IMAGES);
  const bufs = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { Referer: "https://www.xiaohongshu.com/" } });
      if (res.ok) bufs.push(Buffer.from(await res.arrayBuffer()));
    } catch {
      // 单张下载失败就跳过，不影响其它图
    }
  }
  return bufs;
}

// ---------- 多模态分类：看文字+看图，同时判断"命中没命中"和"该展示哪张图" ----------

function buildClassifyPrompt(title, desc, imageCount) {
  return `这是小红书上一条二手闲置帖子(可能是打包卖好几件东西，价格按条列在正文里)，
一共有${imageCount}张图片(按顺序编号0~${imageCount - 1})。

标题：${title}
正文：${desc}

请结合文字和图片，判断这条帖子里有没有出现以下任意一类东西(命中其中任意一类就算match，
不需要三类都有)——**必须真的在图片里看到，不能只凭文字里提了名字就算**：
1. 地毯(rug/carpet，铺在地上的那种，任何材质/尺寸)——"毯子"/"毛毯"/"盖毯"(blanket)不算
2. 宜家(IKEA)品牌的任意家具——沙发/床/桌子/柜子/椅子/置物架/书架等
3. 宜家经典三层金属小推车——通常是黄色/白色/绿色/薄荷绿的三层铁网带轮小推车

帖子经常混着卖好几件不相关的东西(比如IKEA家具旁边混了婴儿车、电器、日用品)，
**展示图片必须是命中的那件东西本身，不能是帖子里别的不相关物品**。

如果标题或正文明确写着这件东西已经卖掉了(SOLD/已出/卖掉啦/已售)，不算命中。

帖子里可能不止一件东西命中(比如同时有地毯和好几件不同的IKEA家具)——**每一件命中的东西都要
挑一张最能展示它的图片**，不要只选一张就完事，让我能把感兴趣的东西都看一眼。

用严格JSON格式回答，不要有多余文字：
\`\`\`json
{
  "verdict": "match",
  "matched_items": [
    { "item": "客厅加厚高级灰地毯 $15", "image_index": 2 },
    { "item": "宜家 KALLAX 八格储物柜 $20", "image_index": 5 }
  ],
  "reason": "..."
}
\`\`\`
verdict三选一："match"、"no_match"、"unsure"。matched_items数组每一项对应一件命中的东西，
"image_index"是能展示它的那张图的编号(0~${imageCount - 1})；同一张图如果能同时展示好几件
东西也可以重复用同一个编号。没命中就matched_items给空数组。`;
}

function extractJsonBlock(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  try { return JSON.parse(text.trim()); } catch { return null; }
}

async function classify(title, desc, imageBufs) {
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      input: [
        { type: "text", text: buildClassifyPrompt(title, desc, imageBufs.length) },
        ...imageBufs.map((buf) => ({ type: "image", data: buf.toString("base64"), mime_type: "image/jpeg" })),
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });
  const json = await res.json();
  const modelOutput = json.steps?.find((s) => s.type === "model_output");
  const textItem = modelOutput?.content?.find((c) => c.type === "text");
  return textItem ? extractJsonBlock(textItem.text) : null;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions],
});

client.once("clientReady", async () => {
  console.log(`[登录成功] ${client.user.tag}`);
  const channel = await client.channels.fetch(env.DISCORD_CHANNEL_ID);

  const lines = (await readFile(ALL_CONTENTS_FILE, "utf-8")).split("\n").filter(Boolean);
  const candidates = lines
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter((o) => FURNITURE_KEYWORDS.includes(o.source_keyword))
    .filter((o) => ONTARIO_PATTERN.test(o.title + o.desc));

  console.log(`安省相关候选: ${candidates.length} 条，开始看图分类+发送...`);

  let sent = 0;
  for (const note of candidates) {
    const imageBufs = await loadNoteImages(note);

    let verdict;
    try {
      verdict = await classify(note.title, note.desc, imageBufs);
    } catch (e) {
      console.error(`分类出错 note_id=${note.note_id}:`, e.message);
      continue;
    }
    if (!verdict || verdict.verdict === "no_match") continue;

    const isUnsure = verdict.verdict === "unsure";
    const items = verdict.matched_items || [];

    // 同一张图可能被好几件东西共用，去重后按出现顺序排——Discord的技巧：多个embed只要
    // 共用同一个url，就会被当成同一张卡片的"图集"，横向grid展示，不用拼图。
    const uniqueIndexes = [...new Set(items.map((i) => i.image_index).filter((i) => typeof i === "number"))];

    const mainEmbed = new EmbedBuilder()
      .setColor(isUnsure ? 0xf1c40f : 0x00b894)
      .setTitle(note.title.slice(0, 250).replace(/\n/g, " "))
      .setURL(note.note_url)
      .setDescription(items.map((i) => i.item).join("\n") || "(没提取到具体条目，点标题看原贴)")
      .addFields({ name: "判断依据", value: verdict.reason || "(无)" })
      .setFooter({ text: isUnsure ? "小红书爬虫 · 拿不准，人工确认一下" : "小红书爬虫" })
      .setTimestamp();

    const files = [];
    const embeds = [mainEmbed];
    uniqueIndexes.slice(0, 9).forEach((idx, i) => {
      const buf = imageBufs[idx];
      if (!buf) return;
      const filename = `listing${i}.jpg`;
      files.push(new AttachmentBuilder(buf, { name: filename }));
      if (i === 0) {
        mainEmbed.setImage(`attachment://${filename}`);
      } else {
        embeds.push(new EmbedBuilder().setURL(note.note_url).setImage(`attachment://${filename}`));
      }
    });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`interested_${note.note_id}`).setLabel("感兴趣").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`skip_${note.note_id}`).setLabel("跳过").setStyle(ButtonStyle.Secondary)
    );

    await channel.send({ embeds, components: [row], files });
    sent++;
    console.log(`[发送 ${sent}] ${verdict.verdict} | ${items.length}件/${uniqueIndexes.length}张图 | ${note.title.slice(0, 30)}`);
    await new Promise((r) => setTimeout(r, 400)); // 客气一点，别糊太快
  }

  console.log(`\n全部发完，共 ${sent} 条。脚本继续跑着监听按钮点击，Ctrl+C退出。`);
});

// 点"感兴趣"要把小红书原贴链接发回去——不在内存里存note_id->url的映射(bot重启就丢了)，
// 每次点击的时候现查all_contents.jsonl，反正这个文件不大，查一次很快，也不用担心重启后失效。
async function findNoteUrl(noteId) {
  const lines = (await readFile(ALL_CONTENTS_FILE, "utf-8")).split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const note = JSON.parse(line);
      if (note.note_id === noteId) return note.note_url;
    } catch {}
  }
  return null;
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  const [action, ...idParts] = interaction.customId.split("_");
  const noteId = idParts.join("_");
  if (action === "interested") {
    const url = await findNoteUrl(noteId);
    await interaction.reply({
      content: url ? `链接给你：${url}` : `没找到这条帖子的链接 (note_id=${noteId})`,
      ephemeral: true,
    });
  } else if (action === "skip") {
    await interaction.reply({ content: `已跳过 (note_id=${noteId})`, ephemeral: true });
  }
  console.log(`[交互] ${action} ${noteId}`);
});

await client.login(env.DISCORD_TOKEN);
