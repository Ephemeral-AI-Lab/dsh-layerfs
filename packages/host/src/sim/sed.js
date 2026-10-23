// GNU sed's command line for the simulated Sandbox's commands on macOS,
// whose BSD sed reads `-i` and `\|` differently: -i (in place), -n, -e, -E,
// addresses (a line number, $, /re/ and ranges of them) and the s, d and p
// commands. Basic regular expressions are GNU's: \( \) \| \{ \} \+ \? are
// operators and their bare forms are literal.
//   node sed.js [-i] [-n] [-E] [-e script]... [script] [file]...
import { readFileSync, writeFileSync } from "node:fs";

const fail = (message) => { process.stderr.write(`sed: ${message}\n`); process.exit(1); };

/** A GNU basic (or extended, with `extended`) regular expression as a JS one. */
function regex(source, extended, flags = "") {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "[") {
      let j = i + 1;
      if (source[j] === "^") j++;
      if (source[j] === "]") j++;
      while (j < source.length && source[j] !== "]") j++;
      out += source.slice(i, j + 1).replace(/\\/g, "\\\\");
      i = j;
    } else if (c === "\\" && i + 1 < source.length) {
      const n = source[++i];
      out += !extended && "()|{}+?".includes(n) ? n : `\\${n}`;
    } else if (!extended && "()|{}+?".includes(c)) out += `\\${c}`;
    else out += c;
  }
  try { return new RegExp(out, flags); } catch (error) { return fail(`-e expression: ${error.message}`); }
}

/** A replacement in GNU's syntax (\1, &, \&, \n) as a JS one. */
function replacement(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      const n = text[++i];
      out += /[1-9]/.test(n) ? `$${n}` : n === "n" ? "\n" : n === "$" ? "$$" : n;
    } else if (c === "&") out += "$&";
    else if (c === "$") out += "$$";
    else out += c;
  }
  return out;
}

/** Text up to the next unescaped `delim` from `i`; a `\delim` becomes the bare character. */
function delimited(script, i, delim) {
  let text = "";
  for (; i < script.length && script[i] !== delim; i++) {
    if (script[i] === "\\" && script[i + 1] === delim) { text += delim === "/" ? "\\/" : delim; i++; }
    else if (script[i] === "\\") { text += script[i] + (script[i + 1] ?? ""); i++; }
    else text += script[i];
  }
  if (i >= script.length) fail(`-e expression: unterminated \`${delim}'`);
  return [text, i + 1];
}

function parse(script, extended) {
  const commands = [];
  let i = 0;
  const address = () => {
    if (/[0-9]/.test(script[i])) { const m = script.slice(i).match(/^[0-9]+/)[0]; i += m.length; return { line: Number(m) }; }
    if (script[i] === "$") { i++; return { last: true }; }
    if (script[i] === "/") { const [text, next] = delimited(script, i + 1, "/"); i = next; return { re: regex(text, extended) }; }
    return null;
  };
  while (i < script.length) {
    while (/[\s;]/.test(script[i] ?? "")) i++;
    if (i >= script.length) break;
    const command = { from: address(), to: null, active: false };
    if (command.from && script[i] === ",") { i++; command.to = address() ?? fail("-e expression: unexpected `,'"); }
    while (script[i] === " ") i++;
    command.name = script[i++];
    if (command.name === "s") {
      const delim = script[i++];
      const [pattern, a] = delimited(script, i, delim);
      const [replace, b] = delimited(script, a, delim);
      i = b;
      const flags = script.slice(i).match(/^[gpI0-9]*/)[0];
      i += flags.length;
      Object.assign(command, { re: regex(pattern, extended, (flags.includes("g") ? "g" : "") + (flags.includes("I") ? "i" : "")), replace: replacement(replace), print: flags.includes("p") });
    } else if (!["d", "p"].includes(command.name)) fail(`-e expression: unknown command: \`${command.name}'`);
    commands.push(command);
  }
  return commands;
}

const hits = (a, line, n, last) => (a.line ? n === a.line : a.last ? last : a.re.test(line));

/** Whether `command` applies to line `n`, advancing its range. */
function selects(command, line, n, last) {
  if (!command.from) return true;
  if (!command.to) return hits(command.from, line, n, last);
  if (command.active) {
    if (command.to.line ? n >= command.to.line : hits(command.to, line, n, last)) command.active = false;
    return true;
  }
  if (!hits(command.from, line, n, last)) return false;
  command.active = !(command.to.line !== undefined && command.to.line <= n);
  return true;
}

function edit(text, commands, quiet) {
  if (text === "") return "";
  const ends = text.endsWith("\n"), lines = (ends ? text.slice(0, -1) : text).split("\n"), out = [];
  for (const c of commands) c.active = false;
  lines.forEach((original, index) => {
    let line = original, deleted = false;
    const n = index + 1, last = n === lines.length;
    for (const c of commands) {
      if (!selects(c, line, n, last)) continue;
      if (c.name === "d") { deleted = true; break; }
      if (c.name === "p") out.push(line);
      if (c.name === "s") {
        c.re.lastIndex = 0;
        const next = line.replace(c.re, c.replace);
        if (next !== line && c.print) out.push(next);
        line = next;
      }
    }
    if (!deleted && !quiet) out.push(line);
  });
  return out.length ? `${out.join("\n")}${ends ? "\n" : ""}` : "";
}

const argv = process.argv.slice(2), scripts = [], files = [];
let inPlace = false, quiet = false, extended = false;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "-e" || arg === "--expression") scripts.push(argv[++i] ?? fail("option requires an argument -- 'e'"));
  else if (arg.startsWith("-i") || arg.startsWith("--in-place")) inPlace = true;
  else if (/^-[nEr]+$/.test(arg)) { quiet ||= arg.includes("n"); extended ||= /[Er]/.test(arg); }
  else if (arg.startsWith("-") && arg !== "-") fail(`invalid option -- '${arg.slice(1)}'`);
  else if (!scripts.length && !files.length) scripts.push(arg);
  else files.push(arg);
}
if (!scripts.length) fail("no script given");
const commands = parse(scripts.join("\n"), extended);
const read = (file) => { try { return readFileSync(file === "-" ? 0 : file, "utf8"); } catch { return fail(`can't read ${file}: No such file or directory`); } };
if (inPlace) {
  if (!files.length) fail("no input files");
  for (const file of files) writeFileSync(file, edit(read(file), commands, quiet));
} else process.stdout.write(edit((files.length ? files : ["-"]).map(read).join(""), commands, quiet));
