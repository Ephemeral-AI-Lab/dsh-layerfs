// Syntax colours for the Files pane: a small lexer per language family,
// picked by the file's name. It colours comments, strings, numbers, keywords,
// literals, types, calls, keys, tags and attributes; it parses nothing, so an
// odd construct is only coloured plainly. Large files are left plain.
import { esc } from "./util.js";

const MAX_BYTES = 400_000;
const words = (s) => new Set(s.split(" "));
const JS_KW = words(
  "as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of package private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield keyof declare namespace module abstract override",
);
const LIT = words("true false null undefined NaN Infinity None True False nil");
const PY_KW = words(
  "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self",
);
const RS_KW = words(
  "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
);
const GO_KW = words(
  "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
);
const SH_KW = words(
  "if then else elif fi for while until do done case esac in function return local export readonly set unset shift exit source alias cd echo exec eval trap",
);
const SQL_KW = words(
  "select from where and or not insert into values update set delete create table index view drop alter add primary key foreign references join left right inner outer on group by order having limit offset as distinct union all exists in is null case when then else end begin commit rollback transaction pragma with recursive integer text blob real default unique check",
);
const CSS_KW = words("important inherit initial unset none auto");

// the language of a path: a lexer family and its keywords
export function langOf(path) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase(),
    ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (
    name === "dockerfile" ||
    name === "makefile" ||
    ["sh", "bash", "zsh", "env"].includes(ext) ||
    name.startsWith(".env")
  )
    return {
      family: "hash",
      kw: SH_KW,
      label: name === "dockerfile" ? "Dockerfile" : name === "makefile" ? "Makefile" : "Shell",
    };
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return { family: "c", kw: JS_KW, label: "JavaScript", jsx: true };
  if (["ts", "tsx", "mts", "cts"].includes(ext))
    return { family: "c", kw: JS_KW, label: "TypeScript", jsx: ext === "tsx" };
  if (["json", "jsonc", "json5"].includes(ext) || name === ".prettierrc" || name === ".eslintrc")
    return { family: "c", kw: new Set(), label: "JSON" };
  if (["rs"].includes(ext)) return { family: "c", kw: RS_KW, label: "Rust" };
  if (["go"].includes(ext)) return { family: "c", kw: GO_KW, label: "Go" };
  if (["c", "h", "cc", "cpp", "hpp", "java", "kt", "swift", "cs", "scala", "dart"].includes(ext))
    return {
      family: "c",
      kw: words(
        "auto break case char class const continue default do double else enum extern float for goto if int long new private protected public return short signed sizeof static struct switch this throw try typedef union unsigned void volatile while import package fun val var let func override final",
      ),
      label: ext.toUpperCase(),
    };
  if (["py", "pyi"].includes(ext)) return { family: "hash", kw: PY_KW, label: "Python", py: true };
  if (["rb"].includes(ext))
    return {
      family: "hash",
      kw: words(
        "def end if elsif else unless while until for in do begin rescue ensure class module return yield self nil require",
      ),
      label: "Ruby",
    };
  if (
    ["yml", "yaml", "toml", "ini", "cfg", "conf", "properties"].includes(ext) ||
    name === ".gitignore" ||
    name === ".npmrc" ||
    name === ".dockerignore"
  )
    return {
      family: "hash",
      kw: new Set(),
      label: ext === "toml" ? "TOML" : ext ? ext.toUpperCase() : "Config",
      keys: true,
    };
  if (["css", "scss", "less", "sass"].includes(ext)) return { family: "css", kw: CSS_KW, label: "CSS" };
  if (["html", "htm", "xml", "svg", "vue", "svelte", "plist"].includes(ext))
    return { family: "tag", kw: new Set(), label: ext === "svg" ? "SVG" : ext === "xml" ? "XML" : "HTML" };
  if (["md", "mdx", "markdown"].includes(ext)) return { family: "md", kw: new Set(), label: "Markdown" };
  if (["sql"].includes(ext)) return { family: "c", kw: SQL_KW, label: "SQL", ci: true, dash: true };
  return null;
}

// Rules are tried in order at each position: [class, sticky regex]. A word
// is classed by what it is and what follows it.
const STR = [
  ["str", /"(?:\\.|[^"\\\n])*"?/y],
  ["str", /'(?:\\.|[^'\\\n])*'?/y],
];
const NUM = ["num", /(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)n?\b/y];
const WORD = ["word", /[A-Za-z_$][\w$]*/y];
const FAMILIES = {
  c: (L) => [
    ["com", /\/\/[^\n]*/y],
    ["com", /\/\*[\s\S]*?(?:\*\/|$)/y],
    ...(L.dash ? [["com", /--[^\n]*/y]] : []),
    ...STR,
    ["str", /`(?:\\[\s\S]|[^`\\])*`?/y],
    ...(L.jsx
      ? [
          ["tag", /<\/?[A-Za-z][\w.]*(?=[\s>\/])/y],
          ["tag", /\/>/y],
        ]
      : []),
    NUM,
    WORD,
  ],
  hash: (L) => [
    ["com", /#[^\n]*/y],
    ...(L.py
      ? [
          ["str", /"""[\s\S]*?(?:"""|$)/y],
          ["str", /'''[\s\S]*?(?:'''|$)/y],
        ]
      : []),
    ...STR,
    ["var", /\$\{?[\w@#?*!-]+\}?/y],
    NUM,
    ["word", /[A-Za-z_][\w-]*/y],
  ],
  css: () => [
    ["com", /\/\*[\s\S]*?(?:\*\/|$)/y],
    ...STR,
    ["kw", /@[\w-]+/y],
    ["num", /#[\da-fA-F]{3,8}\b/y],
    ["num", /-?\d*\.?\d+(?:px|em|rem|%|s|ms|vh|vw|fr|ch|deg|dpi)?\b/y],
    ["word", /-?[A-Za-z_][\w-]*/y],
  ],
  tag: () => [
    ["com", /<!--[\s\S]*?(?:-->|$)/y],
    ["tag", /<\/?[\w:.-]+/y],
    ["tag", /\/?>/y],
    ["attr", /[\w:@.-]+(?=\s*=)/y],
    ...STR,
  ],
  md: () => [
    ["com", /<!--[\s\S]*?(?:-->|$)/y],
    ["str", /```[\s\S]*?(?:```|$)/y],
    ["str", /`[^`\n]*`?/y],
    ["kw", /\*\*[^*\n]+\*\*/y],
    ["fn", /\[[^\]\n]*\]\([^)\n]*\)/y],
  ],
};
const LINE_START = {
  md: [
    ["kw", /#{1,6} [^\n]*/y],
    ["op", /[ \t]*(?:[-*+]|\d+\.) /y],
    ["com", /> [^\n]*/y],
  ],
  hash: [],
};

/** Coloured lines of `text` (HTML), or null when the language is unknown or the file is large. */
export function highlightLines(text, path) {
  const L = langOf(path);
  if (!L || text.length > MAX_BYTES) return null;
  const rules = FAMILIES[L.family](L),
    starts = LINE_START[L.family] || [];
  const parts = []; // [class, text]
  let i = 0,
    plain = "";
  const push = (cls, t) => {
    if (plain) {
      parts.push(["", plain]);
      plain = "";
    }
    parts.push([cls, t]);
  };
  outer: while (i < text.length) {
    const lineStart = i === 0 || text[i - 1] === "\n";
    if (lineStart) {
      for (const [cls, re] of starts) {
        re.lastIndex = i;
        const m = re.exec(text);
        if (m) {
          push(cls, m[0]);
          i += m[0].length;
          continue outer;
        }
      }
      if (L.keys) {
        const m = /[ \t]*-?[ \t]*([\w"'.@\/-]+)(?=[ \t]*[:=](?:\s|$))/y;
        m.lastIndex = i;
        const k = m.exec(text);
        if (k) {
          plain += k[0].slice(0, k[0].length - k[1].length);
          push("prop", k[1]);
          i += k[0].length;
          continue;
        }
      }
    }
    for (const [cls, re] of rules) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (!m || !m[0]) continue;
      const t = m[0];
      i += t.length;
      if (cls === "word") {
        const w = L.ci ? t.toLowerCase() : t,
          next = text.slice(i, i + 40).match(/^\s*(.)/)?.[1];
        if (L.kw.has(w)) push("kw", t);
        else if (LIT.has(t)) push("lit", t);
        else if (L.family === "css" && next === ":" && !/[.#&:]/.test(text[i - t.length - 1] || "")) push("prop", t);
        else if (next === "(" || (next === "!" && L.kw === RS_KW)) push("fn", t);
        else if (/^[A-Z][a-z]/.test(t) && L.family !== "hash") push("typ", t);
        else plain += t;
      } else if (
        cls === "str" &&
        L.family === "c" &&
        /^\s*:/.test(text.slice(i, i + 20)) &&
        !text.slice(i).startsWith("::")
      )
        push("prop", t);
      else push(cls, t);
      continue outer;
    }
    plain += text[i++];
  }
  if (plain) parts.push(["", plain]);
  // split into lines; a token across lines is coloured on each
  const lines = [];
  let cur = "";
  for (const [cls, t] of parts) {
    const seg = t.split("\n");
    seg.forEach((s, k) => {
      if (k > 0) {
        lines.push(cur);
        cur = "";
      }
      if (s) cur += cls ? `<span class="hl-${cls}">${esc(s)}</span>` : esc(s);
    });
  }
  lines.push(cur);
  return lines;
}
