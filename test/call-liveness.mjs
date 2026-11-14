import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'muwu-call-liveness-'));
// 线上默认 3 分钟；测试把超时压到 1.5 秒，用真实时间跑。
process.env.CALL_LIVENESS_TIMEOUT_MS = '1500';
const calls = await import('../lib/muwen/calls.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const owner = { session_id: 'owner-window', window_name: '窗口', is_primary: true };
const norPolls = () => calls.getState({ presence: 'nor' });
const cyPolls = () => calls.pendingForCy(owner.session_id);
// 1) 两边都持续在问：不会被误挂
const a = calls.start('nor', { owner }); calls.action('cy', 'accept', { sessionId: owner.session_id });
norPolls(); cyPolls();
await sleep(900); norPolls(); cyPolls();
await sleep(900); norPolls(); cyPolls();
assert.equal(calls.getState().call.status, 'active', '双方持续报到的电话不能被误挂');
// 2) 棋子这头消失（手机没电/App 崩了）：只剩辞的窗口在问 → 自动挂断，并且能再拨
await sleep(900); cyPolls();
await sleep(900); cyPolls();
const ended = calls.getState().call;
assert.equal(ended.status, 'ended'); assert.equal(ended.ended_by, 'system'); assert.equal(ended.end_reason, 'nor_lost');
assert.equal(calls.history(1)[0].id, a.id, '自动挂断的电话要进历史');
const b = calls.start('nor', { owner }); assert.equal(b.status, 'ringing', '卡死解除后可以再拨');
// 3) 辞的窗口消失：只剩棋子在问 → 同样挂断
calls.action('cy', 'accept', { sessionId: owner.session_id }); norPolls(); cyPolls();
await sleep(900); norPolls();
await sleep(900); norPolls();
assert.equal(calls.getState().call.end_reason, 'cy_lost');
// 4) 响铃中不受心跳影响（仍按 ring_seconds 判未接）
const c = calls.start('cy', { owner }); await sleep(1700);
assert.equal(calls.getState({ presence: 'nor' }).call.status, 'ringing');
assert.equal(calls.getState().call.id, c.id);
calls.action('nor', 'hangup');
console.log('✓ call liveness: both sides alive, nor lost, cy lost, ringing untouched');
