// listen.mjs
//
// 只负责监听交互(按钮点击/斜杠指令)，不负责发消息——跟send_batch.mjs/以后的
// furniture_watch集成分开，这样改交互逻辑不用重新跑一遍发送流程。
//
// 用法：node listen.mjs　(常驻，Ctrl+C退出)

import { Client, GatewayIntentBits } from "discord.js";
import { readFile } from "node:fs/promises";
import { loadEnv } from "./load_env.mjs";

const env = await loadEnv();
const ALL_CONTENTS_FILE = "../scooter-dm-helper/all_contents.jsonl";

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

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once("clientReady", () => console.log(`[监听中] ${client.user.tag}`));

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
