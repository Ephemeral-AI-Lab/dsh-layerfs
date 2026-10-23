// Parse only the shell notation used by the shipped CLI scenarios. Linux
// workspace.exec commands remain opaque arguments, executed by Linux itself.
export function cliPlan(source) {
  let i = 0;
  function word() {
    const parts = []; let text = "", quote = null, seen = false;
    const flush = () => { if (text) { parts.push(text); text = ""; } };
    while (i < source.length) {
      const c = source[i];
      if (!quote && /[\s|;<>()]/.test(c)) break;
      seen = true;
      if (c === quote) { quote = null; i++; continue; }
      if (!quote && (c === "'" || c === '"')) { quote = c; i++; continue; }
      if (c === "\\" && quote !== "'") {
        const next = source[++i];
        if (next === undefined) throw new Error("Incomplete scenario escape");
        if (quote === '"' && !/[\$`"\\\n]/.test(next)) text += "\\";
        if (next !== "\n") text += next;
        i++; continue;
      }
      if (c === "$" && quote !== "'") {
        flush(); i++;
        if (source[i] === "(") { i++; parts.push({ commands: script(true) }); continue; }
        const match = /^[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(i));
        if (!match) throw new Error("Unsupported scenario variable");
        parts.push({ variable: match[0] }); i += match[0].length; continue;
      }
      if (!quote && /[&`>]/.test(c)) throw new Error(`Unsupported scenario operator ${c}`);
      text += c; i++;
    }
    if (quote) throw new Error("Unclosed scenario quote");
    if (!seen) throw new Error(`Unexpected scenario token at ${i}`);
    flush(); return parts.length ? parts : [""];
  }
  function script(nested = false) {
    const commands = []; let pipeline = [], command = { words: [] }, heredoc;
    function finish() {
      if (command.words.length) pipeline.push(command);
      if (pipeline.length) commands.push(pipeline);
      pipeline = []; command = { words: [] };
    }
    while (i < source.length) {
      const c = source[i];
      if (c === " " || c === "\t" || c === "\r") { i++; continue; }
      if (c === "#" && !command.words.length) { while (i < source.length && source[i] !== "\n") i++; continue; }
      if (c === ")" && nested) { i++; finish(); return commands; }
      if (c === "\n" || c === ";") {
        i++;
        if (heredoc) {
          const end = source.indexOf(`\n${heredoc}`, i - 1);
          if (end < 0 || (source[end + heredoc.length + 1] && source[end + heredoc.length + 1] !== "\n")) throw new Error("Unclosed scenario heredoc");
          command.input = source.slice(i, end + 1);
          i = end + heredoc.length + 1; heredoc = undefined;
        }
        finish(); continue;
      }
      if (c === "|") {
        if (source[i + 1] === "|" || !command.words.length) throw new Error("Unsupported scenario pipeline");
        pipeline.push(command); command = { words: [] }; i++; continue;
      }
      if (source.startsWith("<<'", i)) {
        i += 3; const end = source.indexOf("'", i);
        if (end < 0) throw new Error("Unclosed heredoc delimiter");
        heredoc = source.slice(i, end); i = end + 1; continue;
      }
      command.words.push(word());
    }
    if (nested || heredoc) throw new Error("Incomplete scenario command");
    finish(); return commands;
  }
  return script();
}
