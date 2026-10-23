import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const file = process.argv[2];
const request = JSON.parse(readFileSync(file, "utf8"));
if (process.argv[3] === "cli") {
  // Carry large Linux exec strings through a file, avoiding Windows' argv limit.
  process.argv = [process.execPath, process.env.DSH_LAYERFS_CLI, ...request];
  await import(pathToFileURL(process.env.DSH_LAYERFS_CLI).href);
} else {
  const variables = new Map();
  const runner = fileURLToPath(import.meta.url);
  async function child(args, input, capture) {
    // Restricted Windows tokens cannot create Node's named-pipe stdio. Open
    // invocation-owned files instead; uncaptured output still streams to dsh.
    const stdinFile = join(dirname(file), `${randomUUID()}.stdin`);
    const stdoutFile = capture ? join(dirname(file), `${randomUUID()}.stdout`) : null;
    const handles = [];
    try {
      writeFileSync(stdinFile, input ?? "", { flag: "wx" });
      const stdin = openSync(stdinFile, "r"); handles.push(stdin);
      let stdout = "inherit";
      if (stdoutFile) { stdout = openSync(stdoutFile, "wx"); handles.push(stdout); }
      const code = await new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, args, { stdio: [stdin, stdout, "inherit"], windowsHide: true });
        proc.once("error", reject);
        proc.once("close", code => resolve(code ?? 1));
      });
      return { code, output: stdoutFile ? readFileSync(stdoutFile, "utf8") : "" };
    } finally {
      for (const handle of handles) closeSync(handle);
      for (const path of [stdinFile, stdoutFile]) if (path) {
        try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
  }
  async function expand(parts) {
    let value = "";
    for (const part of parts) {
      if (typeof part === "string") value += part;
      else if (part.variable) value += variables.get(part.variable) ?? "";
      else value += (await execute(part.commands, true)).output.replace(/\n+$/, "");
    }
    return value;
  }
  async function execute(commands, capture = false) {
    let output = "", code = 0;
    for (const pipeline of commands) {
      let input;
      for (let index = 0; index < pipeline.length; index++) {
        const command = pipeline[index];
        const argv = [];
        for (const parts of command.words) argv.push(await expand(parts));
        const pipe = index < pipeline.length - 1;
        let result;
        if (argv.length === 1 && /^[A-Za-z_][A-Za-z_0-9]*=/.test(argv[0])) {
          const split = argv[0].indexOf("="); variables.set(argv[0].slice(0, split), argv[0].slice(split + 1));
          result = { code: 0, output: "" };
        } else if (argv.length === 6 && argv.slice(0, 5).join("|") === "IFS=|read|-r|-d|" && /^[A-Za-z_][A-Za-z_0-9]*$/.test(argv[5]) && command.input !== undefined) {
          // Bash read -r -d '' preserves the literal heredoc, including its
          // final newline. EOF assigns the value and returns status 1.
          variables.set(argv[5], command.input);
          result = { code: 1, output: "" };
        } else if (argv[0] === "layerfs") {
          const argsFile = join(dirname(file), `${randomUUID()}.json`);
          writeFileSync(argsFile, JSON.stringify(argv.slice(1)), { flag: "wx" });
          try { result = await child([runner, argsFile, "cli"], command.input ?? input, pipe || capture); }
          finally { unlinkSync(argsFile); }
        } else if (argv[0] === "jq" && argv[1] === "-r" && /^\.[A-Za-z_]+$/.test(argv[2]) && argv.length <= 4) {
          const value = JSON.parse(argv[3] ? readFileSync(argv[3], "utf8") : input)[argv[2].slice(1)];
          result = { code: 0, output: `${value ?? "null"}\n` };
          if (!pipe && !capture) process.stdout.write(result.output);
        } else if (argv[0] === "tee" && argv.length === 2) {
          writeFileSync(argv[1], input ?? ""); result = { code: 0, output: input ?? "" };
          if (!pipe && !capture) process.stdout.write(result.output);
        } else throw new Error(`Unsupported Windows scenario command: ${argv[0]}`);
        code = result.code; input = result.output;
      }
      output += input ?? "";
    }
    return { code, output };
  }
  process.exitCode = (await execute(request)).code;
}
