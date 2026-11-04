// Fixed GUI text-window command, run only by native-text.js in the original restricted Workspace.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const limit=16384;
(async()=>{
 const chunks=[];let size=0;for await(const b of process.stdin){size+=b.length;if(size>131072)throw Error('editor request window');chunks.push(b);}
 const a=JSON.parse(Buffer.concat(chunks).toString('utf8')),parts=a.file.split('/').slice(1);
 if(!a.file.startsWith('/')||!parts.length||parts.some(p=>!p||p==='.'||p==='..'||/[\\:\u0000]/.test(p)||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])([.]|$)/i.test(p)))throw Error('invalid editor path');
 let file=process.cwd();
 for(let i=0;i<parts.length;i++){
  file=path.join(file,parts[i]);
  try{const s=fs.lstatSync(file);if(s.isSymbolicLink()||(i<parts.length-1&&!s.isDirectory()))throw Error('editor refuses symbolic links or non-directory parent');}
  catch(e){if(e.code==='ENOENT'&&i===parts.length-1)break;throw e;}
 }
 const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
 let fd;
 try{fd=fs.openSync(file,a.op==='write'?'r+':'r');}catch(e){if(e.code!=='ENOENT')throw e;}
 let bytes=Buffer.alloc(0),revision=null;
 if(fd!==undefined){
  const stat=fs.fstatSync(fd);if(!stat.isFile())throw Error('editor requires a regular file');
  if(stat.size>limit)throw Error('GUI text window is 16 KiB; use native commands for larger files');
  bytes=Buffer.alloc(stat.size);let at=0;while(at<bytes.length){const n=fs.readSync(fd,bytes,at,bytes.length-at,at);if(!n)throw Error('file changed while reading');at+=n;}
  revision=digest(bytes);
 }
 if(a.op==='read'){
  if(fd!==undefined)fs.closeSync(fd);
  if(bytes.includes(0))throw Error('binary file: use native commands');
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  process.stdout.write(JSON.stringify({kind:'Text',file:a.file,text,revision,exists:revision!==null,limit}));return;
 }
 if(a.op!=='write')throw Error('invalid editor operation');
 if(a.revision!==revision)throw Error('file changed since loaded; reload before saving');
 const value=Buffer.from(a.text,'utf8');if(value.length>limit)throw Error('GUI text window is 16 KiB');
 if(fd===undefined)fd=fs.openSync(file,'wx');
 let at=0;while(at<value.length){const n=fs.writeSync(fd,value,at,value.length-at,at);if(!n)throw Error('short editor write');at+=n;}
 fs.ftruncateSync(fd,value.length);fs.closeSync(fd);
 process.stdout.write(JSON.stringify({kind:'Saved',file:a.file,revision:digest(value),bytes:value.length,committed:false}));
})().catch(e=>{process.stderr.write(String(e.message));process.exitCode=1;});
