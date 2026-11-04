// Bounded GUI text editing through the original restricted Session command.
// No HTTP executable selection and no implicit Commit.
import { readFileSync } from "node:fs";
const LIMIT = 16 * 1024;
const PROGRAM = readFileSync(new URL("./native-text-command.cjs", import.meta.url), "utf8");

export async function editNative(session, request) {
  const bad = (message) => Object.assign(new Error(message), { code: "InvalidInput", status: 400 });
  if (typeof request.file !== "string" || !request.file.startsWith("/") || request.file.length > 4096 || request.file.split("/").slice(1).some((p) => !p || p === "." || p === ".." || /[\\:\u0000]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])([.]|$)/i.test(p))) throw bad("editor file must stay within the Workspace without dot components, backslashes or streams");
  if (request.action === "writeText" && (typeof request.text !== "string" || !request.text.isWellFormed() || request.text.includes("\0") || Buffer.byteLength(request.text) > LIMIT || !(request.revision === null || (typeof request.revision === "string" && /^[0-9a-f]{64}$/.test(request.revision))))) throw bad("text editor accepts a UTF-8 window up to 16 KiB and the exact loaded revision (null for a new file)");
  const child = await session.exec(process.execPath, ["-e", PROGRAM]);
  const consume = async (stream, maximum) => {
    const chunks = []; let length = 0;
    for await (const b of stream) { length += b.length; if (length <= maximum) chunks.push(b); }
    if (length > maximum) throw Object.assign(new Error("editor reply exceeded its GUI window; command output drained, do not replay save"), { code: "Unknown" });
    return Buffer.concat(chunks).toString("utf8");
  };
  const outputs = Promise.all([consume(child.stdout, 128 * 1024), consume(child.stderr, 4096)]);
  outputs.catch(() => {});
  child.stdin.end(JSON.stringify({op:request.action === "readText" ? "read" : "write",file:request.file,text:request.text,revision:request.revision}));
  const [result, [stdout, stderr]] = await Promise.all([child.finished, outputs]);
  if (result.exitCode !== 0) throw Object.assign(new Error(stderr || "original editor command failed"), { code: "EditorRefused", status: 409, detail: { exitCode: result.exitCode } });
  try { return JSON.parse(stdout); } catch { throw Object.assign(new Error("original editor reply invalid; do not replay a save"), { code: "Unknown", status: 409 }); }
}
