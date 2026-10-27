import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'muwen-xinchao-bridge-'));
process.env.XINCHAO_BRIDGE_ACK_WAIT_MS = '500';
process.env.XINCHAO_BRIDGE_ACK_POLL_MS = '25';

const bridge = await import('../lib/muwen/xinchao-bridge.js');
const chat = await import('../lib/muwen/chat.js');

const envelope = {
  protocol: 'xinchao-runtime-wake/1',
  deliveryId: '01JTESTBRIDGE001',
  reason: 'self_signal',
  message: '牵挂从平变成涨。'
};
const headers = {
  'x-xinchao-protocol': envelope.protocol,
  'x-xinchao-delivery-id': envelope.deliveryId
};

const clean = bridge.validateEnvelope(envelope, headers);
const first = await bridge.enqueueEnvelope(clean);
const second = await bridge.enqueueEnvelope(clean);
assert.equal(first.messageId, second.messageId, '同一 deliveryId 重试不能生成第二条木屋消息');
assert.equal(first.status, 'queued');

const pending = chat.pendingForCy();
const message = pending.messages.find(item => item.id === first.messageId);
assert.ok(message, '心潮信号必须进入辞当前主要窗口的待投递队列');
assert.match(message.text_for_cy, /【心潮】牵挂从平变成涨/);

chat.markDelivered([first.messageId], { session_id: 'test-main' });
const delivered = await bridge.waitForDelivery(envelope.deliveryId, 500);
assert.equal(delivered.status, 'delivered');
assert.equal(bridge.bridgeStatus().delivered, 1);

assert.throws(() => bridge.validateEnvelope({ ...envelope, reason: 'unknown' }, headers), /unsupported reason/);
assert.throws(() => bridge.validateEnvelope(envelope, { ...headers, 'x-xinchao-delivery-id': 'wrong' }), /mismatch/);

console.log('xinchao bridge tests passed');
