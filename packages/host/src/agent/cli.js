// The layerfs command in an agent process (DSH_LAYERFS_CLI, run by
// bin/layerfs): LayerFS 2.0 ships the command as a Rust binary; the
// V1 JavaScript entry is gone. Run the binary this checkout builds,
// after env.js has set LAYERFS_* from DSH_LAYERFS_*; the exit code
// and stdout are the command own.
import "./env.js";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { LAYERFS } from "../source.js";

const exe = process.platform === "win32" ? ".exe" : "";
const bin = process.env.LAYERFS_CLI ?? join(LAYERFS, "target/debug/layerfs" + exe);
const run = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
process.exit(run.error ? 1 : run.status ?? 0);
