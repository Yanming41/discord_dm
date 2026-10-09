// math_render.mjs
//
// Discord 不渲染 LaTeX。这里把回复里的公式处理成 Discord 能看的样子：
//   单独成行的公式(\[...\]、$$...$$)：本地用 MathJax 渲染成 PNG(白底黑字，深浅主题都清楚)，作为图片附在对应文字后面
//   行内公式(\(...\)、少量 $...$)：转成 Unicode 符号(eᵢ、ℝᵈ、∂S/∂eᵢ…)，转不干净的放进 `代码格式`
//   代码块(```...``` 和 `...`)里的内容原样不动(比如 PowerShell 的 $_)
// 全部在本机完成，不把内容发到外部网站。
//
// toDiscordSegments(text) → [{ text, images: [Buffer...] }, ...]：按原文顺序，每段文字后面跟着它下方的公式图片。

import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { Resvg } from "@resvg/resvg-js";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const texDoc = mathjax.document("", {
  InputJax: new TeX({ packages: AllPackages.filter((p) => p !== "bussproofs") }),
  OutputJax: new SVG({ fontCache: "none" }),
});

const EX_PX = 9; // MathJax 的尺寸单位是 ex，按 1ex≈9px 换算
const PAD = 14;
const MAX_IMAGES_PER_MESSAGE = 10;

/** 渲染一个公式为 PNG；TeX 写错了返回 null */
export function renderTex(tex) {
  const node = texDoc.convert(tex, { display: true });
  const svg = adaptor.innerHTML(node);
  if (svg.includes("data-mjx-error") || svg.includes('data-mml-node="merror"')) return null;
  const w = Number(svg.match(/width="([\d.]+)ex"/)?.[1] ?? 10) * EX_PX;
  const h = Number(svg.match(/height="([\d.]+)ex"/)?.[1] ?? 3) * EX_PX;
  const inner = svg.replace(/width="[\d.]+ex"/, `width="${w}"`).replace(/height="[\d.]+ex"/, `height="${h}"`).replace(/style="[^"]*"/, "");
  // 外面包一层：白色背景 + 留白，里面放公式本身
  const outer =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w + 2 * PAD}" height="${h + 2 * PAD}">` +
    `<rect width="100%" height="100%" fill="white"/>` +
    `<g transform="translate(${PAD},${PAD})" fill="black" stroke="black">${inner}</g></svg>`;
  return new Resvg(outer, { fitTo: { mode: "zoom", value: 2 } }).render().asPng();
}

// ---------- 行内公式 → Unicode ----------

const SYMBOLS = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ",
  phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ",
  Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  partial: "∂", nabla: "∇", infty: "∞", cdot: "·", times: "×", pm: "±", mp: "∓", div: "÷",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", neq: "≠", ne: "≠", approx: "≈", sim: "∼", equiv: "≡", propto: "∝",
  in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩", emptyset: "∅",
  to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", Leftarrow: "⇐", iff: "⇔", mapsto: "↦",
  sum: "∑", prod: "∏", int: "∫", forall: "∀", exists: "∃", neg: "¬", land: "∧", lor: "∨",
  ldots: "…", cdots: "⋯", dots: "…", top: "⊤", perp: "⊥", circ: "∘", star: "⋆", ast: "∗",
  langle: "⟨", rangle: "⟩", lvert: "|", rvert: "|", lVert: "‖", rVert: "‖", "|": "‖",
  quad: " ", qquad: "  ", ",": " ", ";": " ", "!": "", " ": " ",
};
const FUNCS = ["log", "ln", "exp", "sin", "cos", "tan", "max", "min", "arg", "lim", "det", "sup", "inf", "Pr"];
const BLACKBOARD = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", E: "𝔼", P: "ℙ" };
// 关系符号两边留空格，其他地方 TeX 里的空格都不算数
const RELATIONS = new Set(["=", "∈", "∉", "≤", "≥", "≠", "≈", "≡", "∼", "∝", "→", "←", "⇒", "⇐", "⇔", "↦", "⊂", "⊆", "<", ">"]);
// 字母上方的修饰符用 Unicode 组合字符
const ACCENTS = { hat: "̂", widehat: "̂", bar: "̄", overline: "̅", tilde: "̃", widetilde: "̃", vec: "⃗", dot: "̇", ddot: "̈" };
const SUP = Object.fromEntries([..."0123456789+-=()nijkabcdefghlmoprstuvwxyzT"].map((c, i) => [c, "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱʲᵏᵃᵇᶜᵈᵉᶠᵍʰˡᵐᵒᵖʳˢᵗᵘᵛʷˣʸᶻᵀ"[i]]));
const SUB = Object.fromEntries([..."0123456789+-=()aehijklmnoprstuvx"].map((c, i) => [c, "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ"[i]]));

function readGroup(s, i) {
  // s[i] 是 '{' 时读到配对的 '}'；否则读一个字符(或一个 \命令)
  if (s[i] === "{") {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}" && --depth === 0) return [s.slice(i + 1, j), j + 1];
    }
    return [s.slice(i + 1), s.length];
  }
  if (s[i] === "\\") {
    const m = s.slice(i).match(/^\\([A-Za-z]+|.)/);
    return [m[0], i + m[0].length];
  }
  return [s[i] ?? "", i + 1];
}

function scripted(content, map, fallbackMark) {
  const plain = toUnicode(content);
  const mapped = [...plain].map((c) => map[c]);
  return mapped.every(Boolean) ? mapped.join("") : `${fallbackMark}(${plain})`;
}

function toUnicode(tex) {
  let out = "";
  let i = 0;
  while (i < tex.length) {
    const c = tex[i];
    if (c === "\\") {
      const m = tex.slice(i).match(/^\\([A-Za-z]+|.)/);
      const name = m[1];
      i += m[0].length;
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        const [a, i1] = readGroup(tex, skipSpace(tex, i));
        const [b, i2] = readGroup(tex, skipSpace(tex, i1));
        // 单个"词"(字母、希腊字母、∂、上下标)不加括号，其余加括号免得读错
        const wrap = (x) => (/^[\wͰ-Ͽᴀ-ᶿ⁰-₟∂ℝ.]+$/.test(x) ? x : `(${x})`);
        out += `${wrap(toUnicode(a))}/${wrap(toUnicode(b))}`;
        i = i2;
      } else if (name === "sqrt") {
        const [a, i1] = readGroup(tex, skipSpace(tex, i));
        const inner = toUnicode(a);
        out += inner.length === 1 ? `√${inner}` : `√(${inner})`;
        i = i1;
      } else if (name === "mathbb") {
        const [a, i1] = readGroup(tex, skipSpace(tex, i));
        out += [...a].map((x) => BLACKBOARD[x] ?? x).join("");
        i = i1;
      } else if (["text", "textbf", "textit", "mbox"].includes(name)) {
        const [a, i1] = readGroup(tex, skipSpace(tex, i));
        out += a; // 文字里的空格要保留
        i = i1;
      } else if (["mathrm", "mathbf", "mathit", "operatorname", "boldsymbol", "mathcal"].includes(name)) {
        const [a, i1] = readGroup(tex, skipSpace(tex, i));
        out += toUnicode(a);
        i = i1;
      } else if (name in ACCENTS) {
        const [a, i1] = readGroup(tex, skipSpace(tex, i));
        const inner = toUnicode(a);
        out += [...inner].length === 1 ? inner + ACCENTS[name] : `${name}(${inner})`;
        i = i1;
      } else if (name === "left" || name === "right" || name === "big" || name === "Big" || name === "bigg") {
        // 去掉尺寸修饰，后面的括号照常输出
      } else if (FUNCS.includes(name)) {
        out += name;
      } else if (name in SYMBOLS) {
        out += RELATIONS.has(SYMBOLS[name]) ? ` ${SYMBOLS[name]} ` : SYMBOLS[name];
      } else if ("{}_^$%&#".includes(name)) {
        out += name;
      } else {
        out += `\\${name}`; // 认不出的命令留着，外面会整体放进代码格式
      }
    } else if (c === "_" || c === "^") {
      const [g, i1] = readGroup(tex, i + 1);
      out += scripted(g, c === "_" ? SUB : SUP, c);
      i = i1;
    } else if (c === "{" || c === "}" || /\s/.test(c)) {
      i++;
    } else {
      out += RELATIONS.has(c) ? ` ${c} ` : c === "," ? ", " : c;
      i++;
    }
  }
  return out;
}

const skipSpace = (s, i) => {
  while (s[i] === " ") i++;
  return i;
};

export function inlineTexToText(tex) {
  const u = toUnicode(tex.trim()).replace(/\s+/g, " ").trim();
  return u.includes("\\") ? `\`${tex.trim()}\`` : u;
}

// ---------- 切分：文字 + 公式图片 ----------

// 把代码块/行内代码挑出来，其余部分才处理公式
function splitCode(text) {
  const parts = [];
  const re = /```[\s\S]*?```|`[^`\n]+`/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parts.push({ code: false, s: text.slice(last, m.index) });
    parts.push({ code: true, s: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ code: false, s: text.slice(last) });
  return parts;
}

const INLINE_PAREN = /\\\(([\s\S]+?)\\\)/g;
// 单个 $ 只在里面明显是公式(有 \ ^ _ { )时才算，避免把价格之类误伤
const INLINE_DOLLAR = /(?<![\\$\w])\$(?!\$)([^$\n]{1,200}?)\$(?!\$)/g;
const DISPLAY = /\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$/g;

/** 回复里有没有需要处理的公式 */
export function hasMath(text) {
  // 用不带 g 标志的副本判断，免得全局正则的 lastIndex 状态互相影响
  const display = new RegExp(DISPLAY.source);
  const paren = new RegExp(INLINE_PAREN.source);
  return splitCode(text).some((p) => !p.code && (display.test(p.s) || paren.test(p.s) || /\$[^$\n]*[\\^_{][^$\n]*\$/.test(p.s)));
}

export function toDiscordSegments(text) {
  DISPLAY.lastIndex = 0;
  const segments = [{ text: "", images: [] }];
  const cur = () => segments[segments.length - 1];
  const addText = (s) => {
    // 已经挂了图片的段后面再来文字，就开新的一段，保证文字和图片的先后顺序
    if (cur().images.length && s.trim()) segments.push({ text: "", images: [] });
    cur().text += s;
  };

  for (const part of splitCode(text)) {
    if (part.code) {
      addText(part.s);
      continue;
    }
    let last = 0;
    for (const m of part.s.matchAll(DISPLAY)) {
      addText(convertInline(part.s.slice(last, m.index)));
      const tex = (m[1] ?? m[2]).trim();
      let png = null;
      try {
        png = renderTex(tex);
      } catch {}
      if (png && cur().images.length < MAX_IMAGES_PER_MESSAGE) cur().images.push(png);
      else if (png) segments.push({ text: "", images: [png] });
      else addText(`\n\`\`\`\n${tex}\n\`\`\`\n`); // 渲染失败就原样放代码块
      last = m.index + m[0].length;
    }
    addText(convertInline(part.s.slice(last)));
  }
  return segments
    .map((s) => ({ text: s.text.replace(/\n{3,}/g, "\n\n").trim(), images: s.images }))
    .filter((s) => s.text || s.images.length);
}

function convertInline(s) {
  return s
    .replace(INLINE_PAREN, (_, tex) => inlineTexToText(tex))
    .replace(INLINE_DOLLAR, (all, tex) => (/[\\^_{]/.test(tex) ? inlineTexToText(tex) : all));
}
