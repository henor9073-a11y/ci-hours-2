import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwu-call-upgrade-'));
process.env.DATA_DIR = dir;
const calls = await import('../lib/muwen/calls.js');
const { inputChannel, channelMeta } = await import('../hooks/muwu-input-routing.mjs');
const owner = { session_id: 'owner-window', window_name: '并行电话窗口', is_primary: false };
try {
 assert.equal(calls.looksLikePlaybackEcho('You forgot what you were going to say. Your brain jumped again.',
  ['[softly] You forgot what you were going to say? [teasingly] Your brain jumped again. It will come back.']),true);
 assert.equal(calls.looksLikePlaybackEcho('我刚刚想起来我要说什么了',
  ['你忘记刚刚要说什么了吗？没关系，慢慢想。']),false,'真正的新话不能因为主题相近被吞掉');
 assert.equal(calls.looksLikePlaybackEcho('嗯', ['嗯，慢慢说，我在听。']),false,'太短的插话不能误判成回声');
 assert.equal(calls.looksLikePlaybackEcho('Codex can fix the rest tomorrow.',
  ['[softly] I know. It is still picking up my playback. [pause] But hey, we can hear each other now. [low voice] Codex can fix the rest tomorrow. Do not burn yourself out tonight.']),true,'长句的半截回声也要拦');
 // 按播放时间窗拦回声：辞那句 PCM 流 10:00:00.000～10:00:03.000，手机最多攒 2 秒 + 尾音 1 秒 → 播放窗到 10:00:06.000
 const t0 = Date.now() - 60_000;
 calls.notePlayback('call-win','cy-1',{startedAt:t0, endedAt:t0+3000, bytes:3000*48, format:'pcm_24000'});
 assert.ok(calls.overlapsPlayback('call-win', t0+500, t0+4500).ratio >= 0.99, '完全落在播放里');
 assert.ok(calls.overlapsPlayback('call-win', t0+5000, t0+9000).ratio < 0.3, '辞说完之后才开口的，不是回声');
 assert.equal(calls.overlapsPlayback('call-other', t0+500, t0+4500).ratio, 0, '别的电话的播放不算');
 calls.notePlayback('call-win','cy-2',{startedAt:t0+20000, endedAt:t0+21000, bytes:16*4000, format:'mp3'}); // MP3 4 秒，下载完才放
 assert.ok(calls.overlapsPlayback('call-win', t0+21500, t0+24500).ratio >= 0.99, 'MP3 从流结束开始算播放');
 assert.equal(calls.overlapsPlayback('call-win', t0+15000, t0+19000).ratio, 0, 'MP3 还在下载时不算播放');
 const wav = Buffer.alloc(44 + 48000); wav.write('RIFF',0); wav.writeUInt32LE(36+48000,4); wav.write('WAVE',8); wav.write('fmt ',12); wav.writeUInt32LE(16,16);
 wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(24000,24); wav.writeUInt32LE(48000,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(48000,40);
 assert.equal(calls.wavDurationMs(wav), 1000, 'WAV 头算时长'); assert.equal(calls.wavDurationMs(Buffer.from('not wav at all, really')), 0);
 const a = calls.start('nor', {owner}); calls.action('cy', 'accept', {sessionId:owner.session_id});
 calls.action('nor','accept'); calls.action('cy','accept',{sessionId:owner.session_id});
 assert.equal(calls.getState().events.filter(e=>e.type==='accepted').length,1,'重复按接听不能多记 accepted 事件');
 const one = calls.say('nor','你好','voice',{callId:a.id,segmentId:'seg-1'});
 assert.equal(calls.say('nor','重试','voice',{callId:a.id,segmentId:'seg-1'}).id,one.id);
 assert.throws(()=>calls.say('cy','偷接','voice',{sessionId:'wrong'}));
 assert.throws(()=>calls.say('system','伪造原话'));
 assert.equal(calls.ambient(a.id,{sounds:[{label:'music',confidence:.99}]}).reason,'disabled');
 calls.updateSettings({ambientEnabled:true});
 assert.equal(calls.ambient(a.id,{sounds:[{label:'music',confidence:.1}]}).reason,'uncertain');
 const ambient = calls.ambient(a.id,{sounds:[{label:'music',confidence:.98}]});
 assert.equal(ambient.attach_to,'next_utterance'); assert.match(ambient.text,/音乐/);
 assert.ok(!calls.getState().events.some(e=>e.type==='ambient'),'环境音不再单独成事件推给辞');
 assert.equal(calls.ambient(a.id,{sounds:[{label:'music',confidence:.98}]}).reason,'unchanged');
 const withAmbient = calls.say('nor','背景有音乐时说的','voice',{callId:a.id,segmentId:'seg-amb'});
 assert.match(withAmbient.ambient.text,/音乐/,'环境音附在她紧接着的那一句上');
 assert.ok(!calls.say('nor','再说一句','voice',{callId:a.id,segmentId:'seg-amb-2'}).ambient,'只附一次');
 assert.ok(!calls.transcriptDay(one.at.slice(0,10)).some(e=>e.type==='ambient'));
 calls.setVoiceTone(one.id,{status:'uncertain',tags:[],confidence:.2});
 calls.setVoiceLabel(one.id,{tags:['打闹·玩闹']});
 calls.setVoiceTone(one.id,{emotion:'真生气',confidence:.99});
 assert.deepEqual(calls.event(one.id).voice_label.tags,['打闹·玩闹'],'a late inference must not overwrite correction');
 const clip = calls.favorite({event_ids:[one.id]});
 assert.equal(clip.events[0].call_id,a.id); assert.equal(clip.events[0].type,'utterance');
 assert.equal(calls.favorites().length,1);
 calls.action('nor','hangup');
 calls.setVoiceLabel(one.id,{tags:[]});
 calls.setVoiceLabel(one.id,{skip:true});
 assert.ok(!calls.transcriptDay(one.at.slice(0,10)).some(e=>e.id===one.id),'non-user speech must not feed memory as Nor');
 calls.setVoiceLabel(one.id,{tags:[]});
 assert.deepEqual(calls.history()[0].events.find(e=>e.id===one.id).voice_label.tags,[],'archived correction persists');
 const b=calls.start('nor',{owner});calls.action('nor','accept');
 assert.throws(()=>calls.say('nor','上一通的慢转写','voice',{callId:a.id,segmentId:'late'}),{status:409});
 const before=calls.getState().events.length;
 calls.setVoiceLabel(one.id,{tags:['平静']});
 assert.equal(calls.getState().events.length,before,'old-call correction never wakes a new call');
 assert.equal(calls.favorites()[0].events[0].text,'你好');
 calls.deleteFavorite(clip.id); assert.equal(calls.favorites().length,0);
 assert.throws(()=>calls.favorite({event_ids:[one.id,'unknown']}));
 for (const [sender,type,expected] of [['nor','text','muwu-chat'],['nor','voice','muwu-voice'],['nor','image','muwu-chat'],['system','voice','muwu-system']]) {
  const message={id:'m',sender,type,at:'now'};
  assert.equal(inputChannel(message),expected);
  assert.equal(channelMeta(message).counts_as_user_activity,String(sender==='nor'));
 }
 console.log('✓ call identity, retries, owner isolation, ambient sidecars, corrections, archive, favorites, channel provenance');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
