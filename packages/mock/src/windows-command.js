// Best-effort early cancellation. The scenarios preset also disables timeout
// promotion so dsh's owning process enforces the outer job deadline, including
// when a restricted Windows token cannot terminate descendants itself.
import { spawn } from "node:child_process";

const budget = Number(process.argv[2]);
if (!Number.isInteger(budget) || budget < 1 || budget > 110000) throw new Error("Invalid scenario command deadline");
const child = spawn(process.execPath, process.argv.slice(3), {
  stdio: "inherit", windowsHide: true, detached: process.platform !== "win32",
});
let expired = false;
const timer = setTimeout(() => {
  expired = true;
  console.error(`Scenario command exceeded its ${budget} ms wall deadline; stopping its process tree`);
  if (process.platform === "win32") {
    const stop = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "inherit", windowsHide: true });
    const fallback = error => {
      console.error(`Scenario tree termination failed (${error}); requesting direct child termination; dsh owns the outer job deadline`);
      try { child.kill(); } catch (failure) { console.error(failure); }
    };
    stop.once("error", error => fallback(error.message));
    stop.once("exit", code => { if (code !== 0) fallback(`taskkill exit ${code}`); });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}, budget);
child.once("error", error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.once("exit", code => { clearTimeout(timer); process.exitCode = expired ? 124 : code ?? 1; });
