import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'muwu-call-stream-'));
process.env.DATA_DIR=dir;process.env.ELEVENLABS_API_KEY='test-only';process.env.ELEVENLABS_VOICE_ID='test-only';
const {streamSpeech}=await import('../lib/voice.js');
class Response extends EventEmitter {
 headers={};chunks=[];destroyed=false;writableFinished=false;
 status(code){this.code=code;return this;}
 setHeader(key,value){this.headers[key]=value;}
 flushHeaders(){this.flushed=true;}
 write(data){this.chunks.push(data);this.emit('chunk');return true;}
 end(){this.writableFinished=true;}
}
const original=globalThis.fetch;
try{
 let controller;
 globalThis.fetch=async (url,options)=>{
  assert.match(url,/output_format=pcm_24000$/);
  return {ok:true,body:new ReadableStream({start(c){controller=c;c.enqueue(new Uint8Array([1,2]));}})};
 };
 const response=new Response();
 const firstChunk=new Promise(resolve=>response.once('chunk',resolve));
 let finished=false;
 const work=streamSpeech('hello',response,{format:'pcm_24000'}).then(()=>{finished=true;});
 await firstChunk;
 assert.equal(finished,false,'first audio must be forwarded before the utterance finishes');
 assert.equal(response.headers['X-Audio-Format'],'pcm_24000');
 assert.equal(response.flushed,true);
 controller.enqueue(new Uint8Array([3,4]));controller.close();await work;
 assert.deepEqual([...Buffer.concat(response.chunks)],[1,2,3,4]);
 let aborted=false;
 globalThis.fetch=async (_url,options)=>({ok:true,body:new ReadableStream({start(c){
  c.enqueue(new Uint8Array([1,2]));
  options.signal.addEventListener('abort',()=>{aborted=true;c.error(new Error('cancelled'));},{once:true});
 }})});
 const closed=new Response();
 const gotChunk=new Promise(resolve=>closed.once('chunk',resolve));
 const cancellation=streamSpeech('hello',closed);
 await gotChunk; closed.destroyed=true;closed.emit('close');
 await assert.rejects(cancellation,/cancelled/);
 assert.equal(aborted,true,'hanging up must cancel the upstream audio stream');
 console.log('✓ first-chunk streaming, PCM format, original bytes, upstream cancellation');
}finally{globalThis.fetch=original;fs.rmSync(dir,{recursive:true,force:true});}
