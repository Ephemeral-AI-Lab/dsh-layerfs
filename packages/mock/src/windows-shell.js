// Windows dsh uses PowerShell. Materialize SDK scripts or CLI scenario plans
// in its writable workspace and launch native Node under the same sandbox.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliPlan } from "./windows-cli.js";

export function windowsCall(call, directory) {
  if (call.name !== "bash") return call;
  const match = /^(?:#[^\n]*\n)*node --input-type=module <<'([A-Z_]+)'\n([\s\S]*)\n\1\n?$/.exec(call.args.command);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${randomUUID()}.${match ? "mjs" : "json"}`);
  writeFileSync(file, match ? match[2] : JSON.stringify(cliPlan(call.args.command)), { flag: "wx", encoding: "utf8" });
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  // Keep dsh's process ownership, streams, environment and cancellation. Remove
  // this call's script even on a nonzero exit; cancellation may leave it behind.
  const args = match
    ? quote(file)
    : `${quote(fileURLToPath(new URL("./windows-cli-run.js", import.meta.url)))} ${quote(file)}`;
  const supervisor = quote(fileURLToPath(new URL("./windows-command.js", import.meta.url)));
  const command = `try { & ${quote(process.execPath)} ${supervisor} 110000 ${args}; $code = $LASTEXITCODE } finally { Remove-Item -LiteralPath ${quote(file)} -Force }; exit $code`;
  return { ...call, args: { ...call.args, command, timeoutMs: 120000 } };
}
