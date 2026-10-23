// Bounded protocol proofs: no send before authentication, no replay after an admitted request.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { connection } from "../src/windows/binding.js";
import { absoluteLinux, linuxPath, projectHome } from "../src/windows/paths.js";
import { windowsConfig } from "../src/windows/host.js";
import { frame, readFrames } from "../src/port/frames.mjs";

const windows = windowsConfig({ wslDistribution: "Ubuntu", wslHome: "/var/lib/layerfs/windows" }, "C:\\temp\\layerfs", "test-");
assert.equal(await linuxPath("\\\\wsl.localhost\\Ubuntu\\home\\a b\\src", windows), "/home/a b/src");
await assert.rejects(linuxPath("\\\\wsl$\\Debian\\home\\src", windows), /another WSL distribution/);
await assert.rejects(linuxPath("relative/path", windows), /absolute/);
assert.throws(() => absoluteLinux("C:\\data", "home"), /absolute Linux path/);
assert.throws(() => projectHome(windows, "../other"), /invalid project/);
assert.equal(projectHome(windows, "project-1"), "/var/lib/layerfs/windows/project-1");

for (const authenticated of [false, true]) {
  const secret = randomBytes(32).toString("hex");
  let requests = 0;
  const server = createServer((socket) => {
    let greeted = false;
    socket.on("error", () => {});
    readFrames(socket, (value) => {
      if (!greeted) {
        assert.equal(value.secret, secret);
        if (!authenticated) return socket.destroy();
        greeted = true;
        return socket.write(frame({ id: 0, answer: { value: "hello" } }));
      }
      requests++;
      socket.destroy(); // simulate a lost reply after the server received one mutation
    }, () => socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const timer = setTimeout(() => { throw new Error("Windows protocol test hung"); }, 5000);
  try {
    const answer = await connection({ port: server.address().port, secret }).call({ fn: "call", op: "fs.write", args: {} });
    assert.equal(answer.refused.code, authenticated ? "Unknown" : "Failed");
    assert.equal(requests, authenticated ? 1 : 0);
  } finally {
    clearTimeout(timer);
    await new Promise((resolve) => server.close(resolve));
  }
}
console.log("windows: path boundaries and lost-reply custody pass");
