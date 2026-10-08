// 把 slash_commands.mjs 里的命令注册成服务器命令(立刻生效)，并清空这个 bot 所有的全局命令。
// 用法：node register_commands.mjs        改了命令定义之后重新跑一遍就行(整体覆盖，不会重复)
import { loadEnv } from "./load_env.mjs";
import { registrationPayload } from "./slash_commands.mjs";

const { DISCORD_TOKEN, DISCORD_GUILD_ID } = await loadEnv();
const headers = { Authorization: `Bot ${DISCORD_TOKEN}`, "Content-Type": "application/json" };
const api = async (method, route, body) => {
  const res = await fetch(`https://discord.com/api/v10${route}`, { method, headers, body: body && JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${route} -> HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
};

const app = await api("GET", "/oauth2/applications/@me");
const globals = await api("PUT", `/applications/${app.id}/commands`, []);
console.log(`全局命令已清空(剩 ${globals.length} 个)`);
const guild = await api("PUT", `/applications/${app.id}/guilds/${DISCORD_GUILD_ID}/commands`, registrationPayload());
console.log(`服务器命令已注册 ${guild.length} 个：${guild.map((c) => "/" + c.name).join(" ")}`);
