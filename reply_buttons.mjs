// 回复里的「选项按钮」和「📋 复制」按钮：手机上不好选中文字，一点就能发出 / 复制。
//
// LLM(2B、Claude)在回复里写：
//   ```choices
//   ✅ 授权 | 允许你在自动化 Edge 里……(点了以后作为 zym 的消息原样发出去的话)
//   ❌ 先不用 | 先不用了
//   ```
// 这个块会从正文里拿掉，变成按钮；每行「按钮文字 | 点了发出去的话」，没有 | 就按钮文字=发出去的话。
// 正文里其他 ``` 代码块 → 消息下面加一个「📋 复制」按钮，点了把每个代码块的纯文本单独私发(只有自己看得见)，
// 长按「复制文字」就正好是那段内容。

const CHOICES_BLOCK = /```choices[^\n]*\n([\s\S]*?)```\n?/g;
const CODE_BLOCK = /```([^\n`]*)\n([\s\S]*?)```/g;
const MAX_CHOICES = 10;

export function extractInteractive(text) {
  const choices = [];
  const body = text.replace(CHOICES_BLOCK, (_, inner) => {
    for (const raw of inner.split("\n")) {
      const line = raw.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim();
      if (!line || choices.length >= MAX_CHOICES) continue;
      const bar = line.indexOf("|");
      const label = (bar < 0 ? line : line.slice(0, bar)).trim();
      const send = (bar < 0 ? line : line.slice(bar + 1)).trim() || label;
      if (label) choices.push({ label: label.slice(0, 80), text: send });
    }
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();

  const blocks = [];
  for (const m of body.matchAll(CODE_BLOCK)) {
    const content = m[2].replace(/\n$/, "");
    if (content.trim()) blocks.push(content);
  }
  return { text: body, choices, blocks };
}

// rec.chosen 有值时：按钮全部禁用，选中的那个标绿
export function buildComponents(key, rec) {
  const rows = [];
  const buttons = rec.choices.map((c, i) => ({
    type: 2,
    style: rec.chosen == null ? (i === 0 ? 1 : 2) : rec.chosen === i ? 3 : 2,
    label: c.label,
    custom_id: `br:ch:${key}:${i}`,
    disabled: rec.chosen != null,
  }));
  for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  if (rec.blocks.length) {
    rows.push({
      type: 1,
      components: [{ type: 2, style: 2, label: rec.blocks.length > 1 ? `复制 (${rec.blocks.length} 段)` : "复制", emoji: { name: "📋" }, custom_id: `br:cp:${key}` }],
    });
  }
  return rows;
}

// 私发复制内容：每段单独一条，超长的切开(Discord 单条 2000 字)
export function copyParts(blocks) {
  const out = [];
  for (const b of blocks) {
    for (let i = 0; i < b.length; i += 1990) out.push(b.slice(i, i + 1990));
  }
  return out;
}
