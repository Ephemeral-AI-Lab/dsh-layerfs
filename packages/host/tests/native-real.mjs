// Real native owner lifecycle: product runtime/SDK, no fake Store or daemon.
// node packages/host/tests/native-real.mjs <addon> <parent> <host> <WinFsp> <resident> <fresh-output>
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { LayerFSRuntime } from "@layerfs/runtime";
import { nativeOwner } from "../src/native.js";
import { clientFor } from "../src/layerfs-client.js";
import { projectRuntime } from "../src/runtime.js";
import { removeProject } from "../src/remove.js";
assert.equal(process.platform,"win32");
assert.equal(process.argv.length,8);
const [addon,executable,host,winfsp,restrictedLauncher,out]=process.argv.slice(2).map(p=>resolve(p));
assert.equal(existsSync(out),false,"fresh append-only output required");
mkdirSync(out,{recursive:true});
const home=join(out,"home"),source=join(out,"source");mkdirSync(home);mkdirSync(source);
writeFileSync(join(source,"seed.txt"),"native product owner\n");
const acl=spawnSync("pwsh",["-NoProfile","-Command","$ErrorActionPreference='Stop';$who=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name;& icacls.exe $env:LAYERFS_TEST_HOME /inheritance:r /grant:r ('{0}:(OI)(CI)F' -f $who);if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}"],{env:{...process.env,LAYERFS_TEST_HOME:home},encoding:"utf8",timeout:10000});
assert.ifError(acl.error);assert.equal(acl.status,0,acl.stderr);
process.env.LAYERFS_NATIVE=addon;process.env.LAYERFS_HOME=home;
const runtime=await LayerFSRuntime.open({home,native:true,sweep:false});
const spec={home,native:true,worker:false,prefix:"layerfs-",stateDir:join(out,"bindings"),traceDir:join(out,"trace"),pollMs:400,runtime:Promise.resolve(runtime),nativeWorkspace:{executable,host,winfsp,restrictedLauncher,workRoot:join(out,"instances")}};
let client,instance,mount,error=null;const steps=[];
const owner=nativeOwner(spec);
async function drained() {
 readFileSync(join(mount.path,"gui-lifecycle.txt"));
 const until=Date.now()+8000;
 for(;;){
  const s=await owner.action({name:"owned"},{action:"status",instance:instance.id,path:mount.path});
  if(s.native.handles==="0"&&s.native.active==="0")return s;
  assert(Date.now()<until,"original kernel Close not observed; do not retry unmount");
  await new Promise(r=>setTimeout(r,20));
 }
}
try {
 let init=await runtime.project.start_init("owned",source,{timeout:20000});
 const until=Date.now()+25000;
 while(!init.ended){assert(Date.now()<until,"bounded Init readiness");await new Promise(r=>setTimeout(r,20));init=await runtime.project.get_init(init.id);}
 assert.equal(init.step,"done",JSON.stringify(init.error));
 const project=init.project;
 client=await clientFor(spec,project);await client.layerfs.branch.fork("feature");
 assert.deepEqual((await owner.list(project)).instances,[]);
 assert.equal((await runtime.native.instances()).length,0,"list starts nothing");
 instance=await owner.action(project,{action:"create"});
 assert.equal((await runtime.native.instances()).length,1);
 assert.equal((await owner.list(project)).instances[0].nativeId,instance.nativeId);
 const realView=await projectRuntime({spec},null,project);
 assert.equal(realView.native.instances[0].nativeId,instance.nativeId);
 assert.equal(realView.native.scope,"this-host-runtime");
 await assert.rejects(owner.action({name:"foreign"},{action:"close",instance:instance.id}),{code:"NoSuchSandbox"});
 await assert.rejects(owner.action(project,{action:"mount",instance:instance.id,branch:"missing"}),{code:"NoSuchBranch"});
 await assert.rejects(owner.action(project,{action:"mount",instance:instance.id,branch:"main"}),{code:"NoSuchBranch"});
 assert.equal((await runtime.native.list()).length,0,"bad Branch never creates a Session");
 mount=await owner.action(project,{action:"mount",instance:instance.id,branch:"feature"});
 assert.equal((await runtime.native.list()).length,1);
 await assert.rejects(owner.action(project,{action:"close",instance:instance.id}),{code:"MountsActive"});
 await assert.rejects(removeProject(spec,{byName:()=>project},{forget:()=>{throw Error("must not forget the client before refusing")}},project.name),{code:"busy"});
 writeFileSync(join(mount.path,"gui-lifecycle.txt"),"published through original native owner\n");
 await drained();
 await assert.rejects(owner.action(project,{action:"unmount",instance:instance.id,path:mount.path}),{code:"Dirty"});
 await assert.rejects(owner.action(project,{action:"unmount",instance:instance.id,path:mount.path,discard:true,confirm:"wrong"}),{code:"InvalidInput"});
 const dirty=await owner.list(project);assert.equal(dirty.instances[0].workspaces.length,1);
 assert.equal(dirty.instances[0].workspacesKnown,true,"a prior Dirty refusal does not invalidate a fresh successful snapshot");
 const commit=await owner.action(project,{action:"commit",instance:instance.id,path:mount.path,message:"native owner product integration"});
 assert.equal(commit.kind,"Committed");assert.equal(commit.published,true);
 assert.equal((await client.layerfs.fs.read("feature","/gui-lifecycle.txt")).text,"published through original native owner\n");
 const history=await client.layerfs.branch.list_commits("feature");assert.equal(history.items[0].message,"native owner product integration");
 const state=await owner.list(project);assert.equal(state.instances[0].workspaces.length,1);assert.equal(state.instances[0].workspacesKnown,true);
 assert.equal(typeof state.instances[0].workspaces[0].dirty.inodes,"string","HTTP projection preserves bigint exactly as decimal");
 await drained();
 const receipt=await owner.action(project,{action:"unmount",instance:instance.id,path:mount.path});assert.equal(receipt.kind,"Unmounted");mount=null;
 assert.equal((await runtime.native.list()).length,0);
 const terminal=await owner.action(project,{action:"close",instance:instance.id});assert.equal(terminal.tokenClosed,true);assert.equal(terminal.processExit,0);instance=null;
 assert.equal((await runtime.native.instances()).length,0);
 assert.equal((await owner.list(project)).instances.length,0);
 // The normal plugin accessor also uses the original runtime, not a Sandbox fallback.
 const empty=await projectRuntime({spec},null,project);assert.equal(empty.native.scope,"this-host-runtime");assert.equal(empty.native.instances.length,0);
 steps.push({label:"lifecycle",commit:commit.head,branch:history.items[0].message,terminal,closeActive:"MountsActive",dirtyUnmount:"Dirty",removeActive:"busy",foreignProject:"NoSuchSandbox",badBranchBeforeEffect:true});
 await client.close();client=null;await runtime.close();
 console.log("PASS native Host owner: create/list/mount/Dirty/Commit/unmount/close; same original runtime Sessions");
} catch(e) {error={code:e.code??null,message:e.message};throw e;}
finally {
 if(mount&&instance)await owner.action({name:"owned"},{action:"unmount",instance:instance.id,path:mount.path,discard:true,confirm:mount.path}).catch(()=>{});
 if(instance)await owner.action({name:"owned"},{action:"close",instance:instance.id}).catch(()=>{});
 if(client)await client.close().catch(()=>{});
 const paths={addon,executable,host,winfsp,restrictedLauncher};
 writeFileSync(join(out,"result.json"),JSON.stringify({status:error?"FAIL":"PASS",read_at:new Date().toISOString(),steps,error,runtime_closed:runtime.closed,identity:Object.fromEntries(Object.entries(paths).map(([k,p])=>[k,createHash("sha256").update(readFileSync(p)).digest("hex")]))},null,2));
}
