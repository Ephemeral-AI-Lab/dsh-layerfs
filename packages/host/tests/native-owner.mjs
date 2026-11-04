// Host owner contract: no auto-start/replay, uncertain custody and in-flight scope.
// node packages/host/tests/native-owner.mjs
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeOwner } from "../src/native.js";
const root=mkdtempSync(join(tmpdir(),"lfs-native-owner-"));
const project={name:"test"}, rows=[];let created=0,closed=0,released=0,mutations=0,finishCommit;
const original={id:"native-original",workspace:p=>{if(p!=="/owned")throw Object.assign(Error("not owned"),{code:"NotMounted"});return {};},close:async()=>{closed++;rows.length=0;return {tokenClosed:true,desktopClosed:true,processExit:0};}};
const lf={sandbox:{list_workspaces:async()=>({items:[{path:"/owned",dirty:{inodes:2n,entries:1n}}]})},workspace:{
 mount:async()=>{mutations++;return {path:"/owned"};},
 commit:async()=>{mutations++;return new Promise(r=>finishCommit=r);},
 unmount:async()=>{mutations++;return {kind:"Unmounted"};}
}};
const spec={native:true,nativeWorkspace:{executable:join(root,"parent"),host:join(root,"host"),winfsp:join(root,"winfsp"),restrictedLauncher:join(root,"resident"),workRoot:join(root,"work")},runtime:Promise.resolve({native:{
 instances:async()=>rows,
 create:async({work})=>{created++;rows.push({id:original.id,project:"test",work,state:"running",sessions:1,retainedSessions:0});return original;},
 bindClient:async(c,h,o)=>{assert.equal(c,lf);assert.equal(h,original);assert.equal(o.commitScope,"published");return {sandbox:"1",mode:"windows-restricted"};}
}})};
const owner=new NativeOwner(spec,async()=>({layerfs:lf,backend:{daemon:{workspace:{status:async()=>({native:{handles:0n}})}}},close:async()=>{released++;}}));
assert.equal((await owner.list(project)).instances.length,0);assert.equal(created,0);
const made=await owner.action(project,{action:"create"});assert.equal(created,1);
assert.equal((await owner.list(project)).instances[0].workspaces[0].dirty.inodes,"2");
assert.equal((await owner.list(project)).instances[0].workspacesKnown,true);
await assert.rejects(owner.action(project,{action:"toString",instance:made.id}),{code:"InvalidInput"});
await assert.rejects(owner.action(project,{action:"mount",instance:made.id,branch:"x",executable:"other"}),{code:"InvalidInput"});
await assert.rejects(owner.action({name:"foreign"},{action:"close",instance:made.id}),{code:"NoSuchSandbox"});
await assert.rejects(owner.action(project,{action:"unmount",instance:made.id,path:"/not-owned"}),{code:"NotMounted"});
await assert.rejects(owner.action(project,{action:"unmount",instance:made.id,path:"/owned",discard:true,confirm:"wrong"}),{code:"InvalidInput"});assert.equal(mutations,0);
const pending=owner.action(project,{action:"commit",instance:made.id,path:"/owned"});
await assert.rejects(owner.action(project,{action:"close",instance:made.id}),{code:"Busy"});
const during=(await owner.list(project)).instances[0];assert.equal(during.busy,true);assert.equal(during.workspacesKnown,false);assert.equal(during.sessions,1);
finishCommit({kind:"Committed",revision:3n});assert.equal((await pending).revision,"3");assert.equal(mutations,1);
await owner.action(project,{action:"close",instance:made.id});assert.equal(closed,1);assert.equal(released,1);
assert.equal((await owner.list(project)).instances.length,0);
// Unknown create retains the runtime row; listing does not restart or hide it.
const failedSpec={...spec,runtime:Promise.resolve({native:{instances:async()=>[{id:"retained",project:"test",state:"retained",work:join(root,"unknown")}],create:async()=>{throw Object.assign(Error("lost reply"),{code:"Unknown"});}}})};
const uncertain=new NativeOwner(failedSpec,()=>{throw Error("must not open a client after unknown create");});
await assert.rejects(uncertain.action(project,{action:"create"}),{code:"Unknown"});
const held=await uncertain.list(project);assert(held.instances.some(i=>i.state==="retained"));assert(held.instances.some(i=>i.error?.code==="Unknown"));
await assert.rejects(uncertain.action(project,{action:"close",instance:held.instances.find(i=>i.error?.code==="Unknown").id}),{code:"Unknown"});
await assert.rejects(new NativeOwner({native:true,runtime:spec.runtime}).create(project),{code:"NotConfigured"});
// Binding failure must keep the returned original handle, so explicit close is possible.
let bindCloses=0;
const bindRows=[];
const badBindSpec={...spec,runtime:Promise.resolve({native:{
 instances:async()=>bindRows,
 create:async({work})=>{bindRows.push({id:"bind-owner",project:"test",work,state:"running",sessions:0});return {id:"bind-owner",close:async()=>{bindCloses++;bindRows.length=0;return {processExit:0};}};},
 bindClient:async()=>{throw Object.assign(Error("binding rejected"),{code:"Unauthorized"});}
}})};
const badBind=new NativeOwner(badBindSpec,async()=>({layerfs:lf,close:async()=>{}}));
await assert.rejects(badBind.create(project),{code:"Unauthorized"});
const boundFailure=(await badBind.list(project)).instances[0];
assert.equal(boundFailure.nativeId,"bind-owner");assert.equal(boundFailure.workspacesKnown,false);
assert.equal(boundFailure.state,"running");assert.equal(boundFailure.error.code,"Unauthorized");
await badBind.action(project,{action:"close",instance:boundFailure.id});assert.equal(bindCloses,1);
assert.equal((await badBind.list(project)).instances.length,0);
assert.equal(created,1,"no implicit create/replay during refusals or reads");
console.log("PASS native owner contracts: original identity, scoped action validation, one in-flight mutation, exact bigint projection, retained unknown create and no auto-start");
