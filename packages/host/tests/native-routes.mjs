// Authenticated native route wiring: no read-side creation, validate project scope, keep refusal details.
// node packages/host/tests/native-routes.mjs
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { registerRoutes } from "../src/route.js";
let registered,creates=0,allowed=true;
const runtime={native:{instances:async()=>[],create:async()=>{creates++;throw Error("must not auto-create");}}};
const spec={native:true,runtime:Promise.resolve(runtime)};
const ctx={connection:{requestRejection:()=>allowed?undefined:401},sessions:{get:()=>null},webServer:{register:r=>{registered=r;return ()=>{};}},effect:f=>f()};
const bindings={byName:n=>n==="p"?{name:"p"}:null};
const collector={};const trees={spec};
registerRoutes(ctx,{spec,bindings,collector,trees,jobs:{}});
async function call(method,path,body){
 const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);req.method=method;req.url=path;
 const res={statusCode:200,setHeader(){},end(text){this.body=text?JSON.parse(text):null;}};
 await registered.handler(req,res);return {status:res.statusCode,body:res.body};
}
allowed=false;assert.equal((await call("GET","/layerfs/project/p/native")).status,401);allowed=true;
const first=await call("GET","/layerfs/project/p/native");assert.equal(first.status,200);assert.deepEqual(first.body.instances,[]);assert.equal(first.body.scope,"this-host-runtime");
assert.equal((await call("GET","/layerfs/project/missing/native")).status,404);
assert.equal((await call("POST","/layerfs/project/p/native",{action:"create"})).body.code,"NotConfigured");
assert.equal((await call("POST","/layerfs/project/p/native",{action:"create",executable:"untrusted"})).body.code,"InvalidInput");
assert.equal((await call("POST","/layerfs/project/p/native",{action:"toString",instance:"anything"})).body.code,"InvalidInput");
const view=await call("GET","/layerfs/project/p/runtime");assert.equal(view.status,200);assert.equal(view.body.native.scope,"this-host-runtime");assert.equal(view.body.route,"native");
assert.equal(creates,0);
console.log("PASS native HTTP routes: existing browser auth/project scope, read starts nothing, configured-only creation and native runtime projection");
