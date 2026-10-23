// Worker wire compatibility, binary payloads, fragmented frames and Init stdio.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";
import { decode, encode, frame, readFrames } from "../src/port/frames.mjs";

const value = {
  text: "中文\u0000line\n", empty: undefined, integer: 2n ** 63n,
  binary: Buffer.from([0, 128, 255]), bytes: new Uint8Array([3, 4]),
  arraybuffer: new Uint8Array([5, 6]).buffer, list: [null, undefined, false, -0, NaN, Infinity],
  collision: ["buffer", "this is user data"],
  object: JSON.parse('{"__proto__":{"polluted":true},"type":"Buffer","data":[1,2]}'),
};
assert.deepEqual(decode(encode(value)), value);
assert.equal(JSON.parse(encode(value).toString())[0], "dsh-layerfs", "wire uses JSON rather than a V8 version");
assert.equal({}.polluted, undefined);
assert.deepEqual(decode(encode(Buffer.alloc(1048577, 255))), Buffer.alloc(1048577, 255), "large binary output has no small artificial limit");
for (const bytes of [serialize(value), Buffer.from('["dsh-layerfs",2,null]'), Buffer.from('["dsh-layerfs",1,["bad"]]')]) {
  assert.throws(() => decode(bytes), { code: "ProtocolError" });
}
const stream = new PassThrough(), seen = [], bad = [];
readFrames(stream, (item) => seen.push(item), (error) => bad.push(error));
const joined = Buffer.concat([frame(value), frame({ next: true })]);
for (let offset = 0; offset < joined.length; offset += 7) stream.write(joined.subarray(offset, offset + 7));
assert.deepEqual(seen, [value, { next: true }]);
const broken = Buffer.from([0, 0, 0, 1, 255]);
stream.write(Buffer.concat([broken, frame({ never: true })]));
stream.write(broken);
assert.equal(bad.length, 1, "a bad stream is terminated once");
assert.match(bad[0].message, /worker protocol/);
assert.equal(seen.length, 2, "no request after a protocol failure is dispatched");

const dir = mkdtempSync(join(tmpdir(), "layerfs-wire-")), native = join(dir, "binding.cjs");
writeFileSync(native, "exports.call = async (op, args) => ({ value: { op, args, binary: Buffer.from([0,255]) } });\n");
const run = spawnSync(process.execPath, [fileURLToPath(new URL("../src/port/run.mjs", import.meta.url))], {
  env: { ...process.env, LAYERFS_NATIVE: native },
  input: encode({ fn: "call", op: "project.init", args: { content: value.binary }, open: false }), timeout: 5000,
});
assert.equal(run.status, 0, run.stderr.toString());
assert.deepEqual(decode(run.stdout), { value: { op: "project.init", args: { content: value.binary }, binary: Buffer.from([0, 255]) } });
console.log("frames: versioned JSON, binary, malformed frames and Init stdio pass");
