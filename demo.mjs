// demo.mjs
//
// 试用Discord bot几个跟"汇报工作/通知"场景相关的组件，每样都真发一次，方便肉眼对比效果：
//   1. 纯文字消息
//   2. 富文本卡片(embed)
//   3. 带按钮的消息(交互控件，点了会有真实反应，不是摆设)
//   4. webhook发消息(不需要走bot的Gateway连接)
//   5. 斜杠指令 /status (在频道里输入试试，会有真实回复)
//   6. 给消息加表情回应(reaction)
//
// 用法：node demo.mjs　(会常驻监听，方便你点按钮/敲斜杠指令看到真实反应，Ctrl+C退出)

import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { loadEnv } from "./load_env.mjs";

const env = await loadEnv();
const { DISCORD_TOKEN, DISCORD_GUILD_ID, DISCORD_CHANNEL_ID } = env;
if (!DISCORD_TOKEN || !DISCORD_GUILD_ID || !DISCORD_CHANNEL_ID) {
  throw new Error("缺 .env 配置，检查 DISCORD_TOKEN / DISCORD_GUILD_ID / DISCORD_CHANNEL_ID");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// ---------- 1. 注册一个斜杠指令(guild级别，秒生效，不用等Discord全局同步) ----------

async function registerSlashCommand() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  const command = new SlashCommandBuilder()
    .setName("status")
    .setDescription("查一下爬虫/agent目前的状态(演示用，先返回个假数据)");
  await rest.put(Routes.applicationGuildCommands(client.user.id, DISCORD_GUILD_ID), {
    body: [command.toJSON()],
  });
  console.log("[斜杠指令] /status 已注册，去Discord频道里试试敲 /status");
}

client.once("ready", async () => {
  console.log(`[登录成功] 以 ${client.user.tag} 身份上线`);

  await registerSlashCommand();

  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);

  // ---------- 2. 纯文字 ----------
  await channel.send("【纯文字消息】这是最基础的发送方式，跟微信那边的text_item对应。");

  // ---------- 3. 富文本卡片(embed) ----------
  const embed = new EmbedBuilder()
    .setColor(0x00b894)
    .setTitle("宜家白色衣柜 $80出")
    .setURL("https://www.xiaohongshu.com/explore/example")
    .setDescription("演示用的商品卡片——真实场景里这里放小红书爬虫找到的listing")
    .addFields(
      { name: "价格", value: "$80", inline: true },
      { name: "地点", value: "多伦多列治文山", inline: true }
    )
    .setThumbnail("https://sns-webpic-qc.xhscdn.com/placeholder.jpg")
    .setFooter({ text: "小红书爬虫 · 演示卡片" })
    .setTimestamp();
  await channel.send({ embeds: [embed] });
  console.log("[embed] 已发送富文本卡片示例");

  // ---------- 4. 带按钮的消息(真实可交互，点了会触发下面的interactionCreate) ----------
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("demo_detail").setLabel("查看详情").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("demo_ignore").setLabel("不感兴趣").setStyle(ButtonStyle.Secondary)
  );
  const buttonMsg = await channel.send({
    content: "【带按钮的消息】点下面任意一个按钮试试，会有真实回复：",
    components: [row],
  });
  console.log("[按钮] 已发送，等你在Discord里点击");

  // ---------- 5. 给消息加reaction ----------
  await buttonMsg.react("👀");
  console.log("[reaction] 已经给上面这条消息加了个👀表情");

  // ---------- 6. webhook发消息(不用bot login，纯HTTP POST) ----------
  const webhook = await channel.createWebhook({ name: "小红书爬虫-webhook演示" });
  await webhook.send("【webhook消息】这条不是通过bot的Gateway连接发的，是直接POST到webhook URL——" +
    "如果只需要单向发通知，脚本甚至不用跑discord.js的Client，直接fetch这个URL就行。");
  console.log("[webhook] 已创建webhook并发送一条消息，webhook URL:", webhook.url.replace(/\/[^/]+$/, "/[TOKEN隐藏]"));

  console.log("\n全部演示发送完毕。可以去Discord里：\n  1. 点\"查看详情\"/\"不感兴趣\"按钮\n  2. 敲 /status 斜杠指令\n看真实的交互反应。脚本会一直跑着接收这些交互，Ctrl+C退出。");
});

// ---------- 处理真实的交互(按钮点击 / 斜杠指令) ----------

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === "status") {
    await interaction.reply("【/status演示回复】爬虫状态：正常运行中(这是演示假数据，实际接入后会查真实状态)");
    console.log("[交互] 有人执行了 /status");
    return;
  }
  if (interaction.isButton()) {
    if (interaction.customId === "demo_detail") {
      await interaction.reply({ content: "你点了「查看详情」——实际场景里这里可以触发深入的AI识别流程。", ephemeral: true });
    } else if (interaction.customId === "demo_ignore") {
      await interaction.reply({ content: "你点了「不感兴趣」——实际场景里可以把这条listing标记为跳过。", ephemeral: true });
    }
    console.log(`[交互] 有人点了按钮: ${interaction.customId}`);
  }
});

await client.login(DISCORD_TOKEN);
