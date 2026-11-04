// A real separate agent script process, using only its injected wrapper URLs and public APIs.
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
assert.equal(process.env.LAYERFS_HOME,undefined,"no hidden host LAYERFS env in child");
const {LayerFS}=await import(process.env.DSH_LAYERFS_SDK);
const {LayerFSBackend}=await import(process.env.DSH_LAYERFS_BACKEND);
const {LayerFSRuntime}=await import(process.env.DSH_LAYERFS_RUNTIME);
assert.equal(process.env.LAYERFS_HOME,process.env.DSH_LAYERFS_HOME);
assert.equal(process.env.LAYERFS_STORE_PATH,process.env.DSH_LAYERFS_STORE_PATH);
const deployed=JSON.parse(process.env.DSH_LAYERFS_NATIVE_WORKSPACE);
const runtime=await LayerFSRuntime.open({home:process.env.LAYERFS_HOME,native:true,sweep:false});
const project=process.env.DSH_LAYERFS_PROJECT;
let lf,other,instance,ws,error=null;const steps=[];
const save=value=>writeFileSync(process.argv[2],JSON.stringify(value,(_,v)=>typeof v==="bigint"?v.toString():v,2));
try {
 lf=await LayerFS.open(project);other=await LayerFS.open(project);
 assert.deepEqual(await runtime.native.instances(),[],"imports/open do not auto-create");
 await assert.rejects(lf.workspace.mount("1","agent-feature"),{code:"Unsupported"});
 await assert.rejects(runtime.native.bindClient(lf,{id:"fake-host-handle"},{commitScope:"published"}),{code:"NoSuchSandbox"});
 await lf.branch.fork("agent-feature");
 const {workRoot,...executables}=deployed;
 mkdirSync(workRoot,{recursive:true,mode:0o700});
 instance=await runtime.native.create({project,...executables,work:join(workRoot,"agent-original")});
 const registration=await runtime.native.bindClient(lf,instance,{commitScope:"published"});
 await runtime.native.bindClient(other,instance,{commitScope:"published"});
 ws=await lf.workspace.mount(registration.sandbox,"agent-feature");
 const session=instance.workspace(ws.path);
 const command=await session.exec(process.execPath,["-e","require('node:fs').writeFileSync('agent-proof.txt','agent subprocess original owner 中文\\n');process.stdout.write('saved')"]);
 const collect=async stream=>{const chunks=[];for await(const b of stream)chunks.push(b);return Buffer.concat(chunks).toString("utf8");};
 const streams=Promise.all([collect(command.stdout),collect(command.stderr)]);
 command.stdin.end();const [result,[stdout,stderr]]=await Promise.all([command.finished,streams]);
 assert.equal(result.exitCode,0,stderr);assert.equal(stdout,"saved");
 const backend=LayerFSBackend.of(lf);
 readFileSync(join(ws.path,"agent-proof.txt"));
 const until=Date.now()+8000;
 for(;;){const s=await backend.daemon.workspace.status(ws);if(s.native.handles===0n&&s.native.active===0n)break;assert(Date.now()<until,"original Close not observed");await new Promise(r=>setTimeout(r,20));}
 await assert.rejects(other.workspace.unmount(ws),{code:"Dirty"});
 const published=await other.workspace.commit(ws,"agent subprocess public SDK integration");assert.equal(published.kind,"Committed");
 assert.equal((await lf.fs.read("agent-feature","/agent-proof.txt")).text,"agent subprocess original owner 中文\n");
 const listed=await other.sandbox.list_workspaces(registration.sandbox);assert.equal(listed.items[0].path,ws.path);
 await other.workspace.unmount(ws);ws=null;
 const terminal=await instance.close();instance=null;assert.equal(terminal.tokenClosed,true);assert.equal(terminal.desktopClosed,true);assert.equal(terminal.processExit,0);
 assert.deepEqual(await runtime.native.instances(),[]);assert.deepEqual(await runtime.native.list(),[]);
 await other.close();other=null;await lf.close();lf=null;await runtime.close();
 steps.push({published:published.head,message:"agent subprocess public SDK integration",stdout,terminal,scope:"agent-process-only",twoClientsOneOriginal:true,unregisteredRefused:true,fakeHandleRefused:true});
 save({status:"PASS",pid:process.pid,parentPid:process.ppid,read_at:new Date().toISOString(),runtime_closed:runtime.closed,steps,error});
 console.log("PASS separate agent process: injected wrappers/public SDK/native runtime; explicit original owner, restricted command, Commit/readback and terminal close");
} catch(e){error={code:e.code??null,message:e.message};save({status:"FAIL",pid:process.pid,read_at:new Date().toISOString(),runtime_closed:runtime.closed,steps,error});throw e;}
