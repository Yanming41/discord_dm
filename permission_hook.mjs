// Claude Code 的 PermissionRequest 钩子：Claude 要权限时，在 Discord 帖子里发带按钮的消息让 zym 点，
// 不用切回 dinotty 终端。桥接启动 Claude 时用 --settings 挂上(见 discord_bridge.mjs 的 PERMISSION_SETTINGS)。
//
// 流程：把请求交给桥接(POST /permission/ask) → 每 1.5 秒问一次结果(GET /permission?key=) → 按结果输出 allow/deny。
// 不是桥接开的会话、桥接没开、超时(9 分半，钩子上限 10 分钟)或出任何错：什么都不输出直接退出，终端照常弹确认框。
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const API = "http://127.0.0.1:8793";
const TOKEN_FILE = path.join(os.homedir(), ".discord_dm", "bridge_api_token");
const DEADLINE_MS = 570_000;
const POLL_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const req = JSON.parse(input);
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  const call = async (method, route, body) => {
    const res = await fetch(`${API}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  const asked = await call("POST", "/permission/ask", {
    session_id: req.session_id,
    tool_name: req.tool_name,
    tool_input: req.tool_input,
    mcp_server: req.mcp_server,
    permission_suggestions: req.permission_suggestions ?? [],
  });
  if (!asked.key) return; // 不是桥接开的会话

  const until = Date.now() + DEADLINE_MS;
  while (Date.now() < until) {
    await sleep(POLL_MS);
    const { decision } = await call("GET", `/permission?key=${asked.key}`);
    if (!decision) continue;
    if (decision === "expired") return;
    const out =
      decision === "deny"
        ? { behavior: "deny", message: "zym 在 Discord 里拒绝了这个操作。先别继续这一步，问问他想怎么做。" }
        : decision === "always" && req.permission_suggestions?.length
          ? { behavior: "allow", updatedPermissions: req.permission_suggestions }
          : { behavior: "allow" };
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: out } }));
    return;
  }
  await call("POST", "/permission/expire", { key: asked.key }).catch(() => {});
}

main().catch(() => {});
