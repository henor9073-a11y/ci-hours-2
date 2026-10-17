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
  sender: 'nor', type: 'text', content: '新记录', source_device: 'sigh_ios', client_message_id: 'ios-retry-1'
});
for (const key of required) assert.ok(Object.hasOwn(created, key), `new record missing ${key}`);
assert.equal(created.message_id, created.id);
assert.equal(created.kind, 'text');
assert.equal(created.source_device, 'sigh_ios');
assert.equal(created.created_at, created.at);
assert.equal(created.send_status, 'sent');
assert.equal(created.streaming_playback_state, 'none');

const retry = await chat.sendMessage({
  sender: 'nor', type: 'text', content: '新记录', source_device: 'sigh_ios', client_message_id: 'ios-retry-1'
});
assert.equal(retry.id, created.id, '同一个客户端请求重试时不能重复落库');
assert.equal(chat.getMessages({ limit: 100 }).filter(m => m.client_message_id === 'ios-retry-1').length, 1);

const mirror = await chat.sendMessage({
  sender: 'cy', type: 'claude_mirror', content: '只读的 Claude 原话', mirror_key: 'claude-turn-1', mirror_only: true
});
const mirrorRetry = await chat.sendMessage({
  sender: 'cy', type: 'claude_mirror', content: '只读的 Claude 原话', mirror_key: 'claude-turn-1', mirror_only: true
});
assert.equal(mirrorRetry.id, mirror.id, '同一轮 Claude 原话只能镜像一次');
assert.ok(!chat.historyDay(mirror.date).some(m => m.id === mirror.id), 'Claude 镜像不能重复进入木屋历史导出');
assert.ok(!chat.searchChat({ q: '只读的 Claude 原话' }).hits.some(m => m.id === mirror.id), 'Claude 镜像不能成为第二份搜索结果');

assert.deepEqual(chat.getSyncSettings(), { auto_sync_reply: false }, '自动同步必须默认关闭，保持现状');
assert.deepEqual(chat.setSyncSettings({ auto_sync_reply: true }), { auto_sync_reply: true });
const autoReply = await chat.sendMessage({
  sender: 'cy', type: 'text', content: 'Claude 自动同步正文', thinking: '真实思考',
  tools: [{ name: 'Get Calendar', input: '{"days": 3}', result: '三天' }],
  reply_to: '', source_device: 'claude_auto_sync', mirror_key: 'claude-auto-turn-1', mirror_only: true
});
const autoReplyRetry = await chat.sendMessage({
  sender: 'cy', type: 'text', content: 'Claude 自动同步正文', mirror_key: 'claude-auto-turn-1', mirror_only: true
});
assert.equal(autoReplyRetry.id, autoReply.id, '自动同步同一回合只能落一条正常气泡');
assert.equal(autoReply.type, 'text');
assert.equal(autoReply.thinking, '真实思考');
assert.equal(autoReply.tools[0].result, '三天');
assert.equal(autoReply.reply_to, '', '自动同步默认自然续聊，不逐条引用上一条消息');
assert.ok(!chat.historyDay(autoReply.date).some(m => m.id === autoReply.id), '自动同步气泡不能和 Claude 原记录重复进入统一历史');
const autoPending = chat.pendingForCy();
assert.equal(autoPending.reply_mode, 'auto_sync');
assert.match(autoPending.messages.find(m => m.id === created.id).text_for_cy, /不要为文字调用 chat_reply/);
chat.setSyncSettings({ auto_sync_reply: false });
const toolPending = chat.pendingForCy();
assert.equal(toolPending.reply_mode, 'tool');
assert.match(toolPending.messages.find(m => m.id === created.id).text_for_cy, /所有文字回复必须调用 chat_reply/);

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
