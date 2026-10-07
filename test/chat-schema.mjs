import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwen-chat-schema-'));
process.env.DATA_DIR = dataDir;

fs.writeFileSync(path.join(dataDir, 'chat.json'), JSON.stringify([{
  id: 'legacy-1', sender: 'nor', type: 'text', content: '旧记录',
  at: '2026-10-07T00:00:00.000Z', date: '2026-10-07', read: false
}], null, 2));

const chat = await import('../lib/muwen/chat.js');

const required = [
  'message_id', 'sender', 'kind', 'content', 'media_attachments', 'voice_duration',
  'transcript', 'send_status', 'source_device', 'created_at', 'reply_to',
  'streaming_playback_state'
];

const legacy = chat.getMessages({ limit: 10 })[0];
for (const key of required) assert.ok(Object.hasOwn(legacy, key), `legacy record missing ${key}`);
assert.equal(legacy.message_id, 'legacy-1');
assert.equal(legacy.kind, 'text');
assert.equal(legacy.send_status, 'sent');
assert.deepEqual(legacy.media_attachments, []);

const created = await chat.sendMessage({
  sender: 'nor', type: 'text', content: '新记录', source_device: 'sigh_ios'
});
for (const key of required) assert.ok(Object.hasOwn(created, key), `new record missing ${key}`);
assert.equal(created.message_id, created.id);
assert.equal(created.kind, 'text');
assert.equal(created.source_device, 'sigh_ios');
assert.equal(created.created_at, created.at);
assert.equal(created.send_status, 'sent');
assert.equal(created.streaming_playback_state, 'none');

chat.markDelivered([created.id]);
assert.equal(chat.getMessage(created.id).send_status, 'read');

const watch = await chat.sendMessage({
  sender: 'nor', kind: 'watch', content: '手表消息', source_device: 'apple_watch'
});
assert.equal(watch.type, 'watch');
assert.equal(watch.kind, 'watch');

const call = chat.sendCallRecord({
  id: 'call-test', caller: 'nor', status: 'ended',
  accepted_at: '2026-10-07T00:00:00.000Z', ended_at: '2026-10-07T00:01:02.000Z', ended_by: 'nor'
});
assert.equal(call.kind, 'call');
assert.equal(call.source_device, 'call');
assert.equal(call.content, '通话时长 01:02');

console.log('chat schema tests passed');
