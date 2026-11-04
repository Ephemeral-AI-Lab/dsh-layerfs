// Fixed bounded native text command contracts; the real restricted integration is native-real.mjs.
// node packages/host/tests/native-text.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync,writeFileSync,readFileSync,symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { editNative } from "../src/native-text.js";
const root=mkdtempSync(join(tmpdir(),"native-text-"));
const cmd=fileURLToPath(new URL("../src/native-text-command.cjs",import.meta.url));
const run=(op,file,more={})=>spawnSync(process.execPath,[cmd],{cwd:root,input:JSON.stringify({op,file,...more}),encoding:"utf8",timeout:10000});
const missing=run("read","/new.txt");assert.equal(missing.status,0,missing.stderr);assert.equal(JSON.parse(missing.stdout).revision,null);
const saved=run("write","/new.txt",{text:"中文\n",revision:null});assert.equal(saved.status,0,saved.stderr);const rev=JSON.parse(saved.stdout).revision;
assert.equal(readFileSync(join(root,"new.txt"),"utf8"),"中文\n");
const loaded=run("read","/new.txt");assert.equal(JSON.parse(loaded.stdout).text,"中文\n");assert.equal(JSON.parse(loaded.stdout).revision,rev);
assert.notEqual(run("write","/new.txt",{text:"stale",revision:null}).status,0);assert.equal(readFileSync(join(root,"new.txt"),"utf8"),"中文\n");
const empty=run("write","/new.txt",{text:"",revision:rev});assert.equal(empty.status,0,empty.stderr);assert.equal(readFileSync(join(root,"new.txt")).length,0);
for(const file of ["/../escape","/x:stream","/NUL","/CON.txt","/a\\b","/bad."]){assert.notEqual(run("read",file).status,0,file);}
writeFileSync(join(root,"bom.txt"),Buffer.from([239,187,191,65]));assert.equal(JSON.parse(run("read","/bom.txt").stdout).text,"\ufeffA");
writeFileSync(join(root,"binary.dat"),Buffer.from([0,1]));assert.notEqual(run("read","/binary.dat").status,0);
writeFileSync(join(root,"large.txt"),"x".repeat(16385));assert.notEqual(run("read","/large.txt").status,0);
assert.notEqual(run("write","/large-new.txt",{text:"x".repeat(16385),revision:null}).status,0);
if(process.platform==="win32"){symlinkSync(join(root,"new.txt"),join(root,"link.txt"),"file");assert.notEqual(run("read","/link.txt").status,0);}
let started=0;const fake={exec:async()=>{started++;throw Error("must not start");}};
for(const file of ["/../escape","/NUL","/x:stream","/a\\b"]){await assert.rejects(editNative(fake,{action:"readText",file}),{code:"InvalidInput"});}
await assert.rejects(editNative(fake,{action:"writeText",file:"/a",text:"x".repeat(16385),revision:null}),{code:"InvalidInput"});
assert.equal(started,0,"invalid UI inputs never launch native commands");
console.log("PASS native text: UTF-8/empty exact, bounded UI window, stale revision refused, symlink/device/stream/parent paths refused, invalid before native admission");
