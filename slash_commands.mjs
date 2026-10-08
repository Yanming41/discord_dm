// 斜杠命令：定义 + 把一次命令调用还原成"手打的那条文字"，交给桥接按普通消息处理。
// discord_dm.mjs 用 toCommandText/commandScope 处理菜单里的命令；register_commands.mjs 用 COMMANDS 注册到服务器。

const STRING = 3;
const INTEGER = 4;
const BOOLEAN = 5;

// scope：thread=只能在 Claude Code 帖子里用，main=只能在主频道用，any=都行
export const COMMANDS = [
  { name: "stop", scope: "thread", description: "中止这个帖子里 Claude 正在做的任务" },
  { name: "screen", scope: "thread", description: "看这个会话终端当前的画面" },
  { name: "end", scope: "thread", description: "结束这个会话并关掉终端(记录保留，之后能接回来)" },
  { name: "clear", scope: "thread", description: "在这个帖子里换一个全新的 Claude 会话" },
  { name: "compact", scope: "thread", description: "压缩 Claude 的上下文" },
  {
    name: "model",
    scope: "thread",
    description: "换 Claude 的模型",
    options: [{ type: STRING, name: "name", description: "模型名，比如 opus、sonnet", required: true }],
  },
  {
    name: "effort",
    scope: "thread",
    description: "调 Claude 的思考强度",
    options: [{ type: STRING, name: "level", description: "档位，比如 low、medium、high", required: true }],
  },
  { name: "context", scope: "thread", description: "看 Claude 的上下文占用" },
  { name: "cost", scope: "thread", description: "看这个会话的花费" },
  {
    name: "mode",
    scope: "thread",
    description: "切 Claude 的权限模式",
    options: [
      {
        type: STRING,
        name: "mode",
        description: "模式",
        required: true,
        choices: [
          { name: "plan(只规划不动手)", value: "plan" },
          { name: "auto(自动)", value: "auto" },
          { name: "accept(自动接受编辑)", value: "accept" },
          { name: "default(默认)", value: "default" },
        ],
      },
    ],
  },
  {
    name: "cc",
    scope: "main",
    description: "开一个新的 Claude Code 会话(论坛里新建帖子)",
    options: [{ type: STRING, name: "title", description: "会话标题", required: true }],
  },
  { name: "sessions", scope: "main", description: "列出电脑上最近的 Claude 会话" },
  {
    name: "resume",
    scope: "main",
    description: "把 /sessions 列表里的某个会话接到新帖子里",
    options: [
      { type: INTEGER, name: "number", description: "/sessions 列表里的编号", required: true, min_value: 1 },
      { type: BOOLEAN, name: "force", description: "这个会话最近还在更新(标了⚠️)时，确认要接", required: false },
    ],
  },
  { name: "list", scope: "main", description: "看已经绑定到帖子的会话" },
  { name: "2b-new", scope: "main", description: "让 2B 开始一段新对话(长期记忆还在)" },
  {
    name: "help",
    scope: "any",
    description: "操作手册",
    options: [
      {
        type: STRING,
        name: "topic",
        description: "主题，不选就看总览",
        required: false,
        choices: [
          { name: "2B 前台", value: "2b" },
          { name: "会话", value: "sessions" },
          { name: "聊天和状态", value: "chat" },
          { name: "指令", value: "commands" },
          { name: "常见问题", value: "faq" },
          { name: "其他", value: "other" },
          { name: "全部", value: "all" },
          { name: "置顶到主频道", value: "pin" },
        ],
      },
    ],
  },
];

const byName = new Map(COMMANDS.map((c) => [c.name, c]));

export const commandScope = (name) => byName.get(name)?.scope ?? null;

// 一次命令调用 → 等价的手打文字
export function toCommandText(interaction) {
  const name = interaction.commandName;
  const opt = (key) => interaction.options.get(key)?.value;
  switch (name) {
    case "2b-new":
      return "/2b new";
    case "cc":
      return `/cc ${opt("title")}`;
    case "resume":
      return `/resume ${opt("number")}${opt("force") ? "!" : ""}`;
    case "model":
      return `/model ${opt("name")}`;
    case "effort":
      return `/effort ${opt("level")}`;
    case "mode":
      return `/mode ${opt("mode")}`;
    case "help":
      return `/help ${opt("topic") ?? ""}`.trim();
    default:
      return `/${name}`;
  }
}

// 注册用的格式(去掉 scope 这个自定义字段)
export const registrationPayload = () => COMMANDS.map(({ scope, ...c }) => c);
