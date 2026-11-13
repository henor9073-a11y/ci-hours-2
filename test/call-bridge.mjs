import assert from 'node:assert/strict';
import { startCallBridge } from '../hooks/voice-channel-calls-addon.mjs';
import { safeMeta } from '../hooks/muwu-input-routing.mjs';

const original = { fetch: globalThis.fetch, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, now: Date.now };
const tick = () => new Promise(resolve => setImmediate(resolve));
const intervals = new Map(), notifications = [], acknowledged = new Set();
let clock = 0, nextTimer = 0, failAck = false;
let payload = { call: { id: 'call-a', owner_session_id: 'window-a' }, events: [], settings: { tokenMode: 'balanced' } };
const event = (id, type, extra = {}) => ({ id, type, call_id: payload.call.id, at: '2026-11-13T12:00:00Z', ...extra });
globalThis.setInterval = fn => { const id=++nextTimer; intervals.set(id,fn); return id; };
globalThis.clearInterval = id => intervals.delete(id);
Date.now = () => clock;
globalThis.fetch = async (url, options={}) => {
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('session_id'), 'window-a');
  if (parsed.pathname === '/api/call/pending') return { ok: true, json: async () => ({ ...payload, events: payload.events.filter(e => !acknowledged.has(e.id)) }) };
  assert.equal(parsed.pathname, '/api/call/delivered');
  if (failAck) return { ok: false, status: 503 };
  for (const id of JSON.parse(options.body).ids) acknowledged.add(id);
  return { ok: true };
};
let bridge;
const start = extra => startCallBridge({ mcp: { notification: async value => notifications.push(value.params) },
  muwu: { url: 'https://call-test.invalid', token: 'fixture', sessionId: 'window-a' },
  safeMeta, nursery: false, log: () => {}, ...extra });
const poll = async () => { for (const fn of [...intervals.values()]) fn(); await tick(); };
try {
  payload.events = [event('ready','accepted'),event('speech','utterance',{text:'你好',source:'voice',analysis_status:'ready',
    voice_tone:{tone:'语速稍慢',emotion:'累',confidence:.8}}),
    event('legacy-tone','voice_observation',{text:'旧版分开发送的语气观察'}),
    event('room','ambient',{text:'背景里可能有音乐',source:'environment_audio'})];
  failAck = true;
  bridge = start(); await tick();
  const spoken = notifications.find(n => n.meta.event_id === 'speech');
  assert.ok(spoken,'balanced delivery must not wait for another timer after VAD has completed');
  assert.match(spoken.content,/你好[\s\S]*同一句的声音观察：语速稍慢；可能的情绪：累/);
  assert.equal(spoken.meta.call_id,'call-a'); assert.equal(spoken.meta.owner_session_id,'window-a');
  assert.equal(spoken.meta.reply_tool,'call_say');
  for (const note of notifications.filter(n => n.meta.event_id !== 'speech')) {
    assert.equal(note.meta.speaker,'system'); assert.equal(note.meta.origin,'muwu_system');
    assert.equal(note.meta.counts_as_user_activity,'false');
  }
  failAck = false; await poll();
  assert.equal(notifications.length,3,'voice observations must not create a second prompt and ACK retries must not duplicate events');
  assert.equal(acknowledged.size,4,'a legacy separate observation is silently acknowledged');
  bridge.stop(); notifications.length=0; acknowledged.clear();

  payload.events=[event('manual','utterance',{text:'其实不是生气',source:'voice',analysis_status:'ready',
    voice_tone:{tone:'音量偏高',emotion:'生气',confidence:.9},
    voice_label:{tags:['嘴硬','委屈','想念','吃醋'],note:'我当时其实在忍笑'}})];
  bridge=start();await tick();
  assert.equal(notifications.length,1);
  assert.match(notifications[0].content,/她本人纠正的感受：嘴硬、委屈、想念、吃醋；她的补充：我当时其实在忍笑；人工更正优先于机器推测/);
  assert.doesNotMatch(notifications[0].content,/音量偏高|机器.*生气/,'人工更正不能和机器猜测混在一起');
  bridge.stop(); notifications.length=0; acknowledged.clear();

  payload.settings.tokenMode='economy';
  payload.events=[event('old','utterance',{text:'旧电话尚未投递',source:'voice'})];
  bridge=start(); await tick(); assert.equal(notifications.length,0);
  payload={call:{id:'call-b',owner_session_id:'window-a'},events:[],settings:{tokenMode:'balanced'}};
  payload.events=[event('new','utterance',{text:'新电话',source:'voice'})];
  clock=2000;await poll();
  assert.equal(notifications.length,1);assert.equal(notifications[0].content,'新电话');
  assert.equal(notifications[0].meta.call_id,'call-b','a buffered old utterance must never be attributed to a new call');
  bridge.stop(); notifications.length=0; acknowledged.clear();

  payload.events=[event('filtered-room','ambient',{text:'水声'}),event('filtered-speech','utterance',{text:'我在',source:'voice'})];
  bridge=start({eventTypes:e=>e.type==='utterance'});await tick();
  assert.equal(notifications.length,1);assert.equal(notifications[0].meta.event_id,'filtered-speech');
  assert.deepEqual([...acknowledged],['filtered-speech'],'a dedicated call channel must not consume system events');
  console.log('✓ immediate balanced delivery, system provenance, ACK retries, call boundaries, dedicated-channel filtering');
} finally {
  bridge?.stop();
  Object.assign(globalThis,{fetch:original.fetch,setInterval:original.setInterval,clearInterval:original.clearInterval});
  Date.now=original.now;
}
