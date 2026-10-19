import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwen-continuity-test-'));
process.env.DATA_DIR = dataDir;
delete process.env.MUWEN_CONTINUITY_EVENT_LOG;
delete process.env.MUWEN_COMMITMENT_TRACKER;
delete process.env.MUWEN_CONTINUITY_CONTENT_MODE;

const continuity = await import('../lib/muwen/continuity.js');

assert.deepEqual(continuity.featureFlags(), {
  event_log: true,
  commitment_tracker: true,
  content_mode: 'sanitized_text'
});

continuity.recordClaudeTurn({
  session_id: 'session-main', turn_id: 'turn-1',
  user_input: '请在今天做完这件事', content: '好，我先做最小一步。',
  thinking: 'HIDDEN_CHAIN_MUST_NEVER_BE_LOGGED',
  thinking_present: true, thinking_chars: 33,
  runtime: { model: 'claude-test', context_tokens: 1234, config: { effort: 'high' } },
  rules: [{ id: 'no-template-talk.py', reason: '草稿触发重写' }],
  rewrite_occurred: true, rewrite_reason: '模板化表达', rewrite_attempts: 1
}, { allowed: true, primary_session_id: 'session-main' });

continuity.recordToolCall({
  name: 'get_location', args: { exact: true },
  result: { latitude: -37.123456, longitude: 144.123456, token: 'super-secret-token' },
  ok: true, duration_ms: 12, session_id: 'session-main'
});

const eventFile = path.join(dataDir, 'continuity-events', `${new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' })}.jsonl`);
const rawLog = fs.readFileSync(eventFile, 'utf8');
assert.ok(!rawLog.includes('HIDDEN_CHAIN_MUST_NEVER_BE_LOGGED'), '隐藏思维内容不能进入连续性日志');
assert.ok(!rawLog.includes('-37.123456') && !rawLog.includes('144.123456'), '精确位置不能进入日志');
assert.ok(!rawLog.includes('super-secret-token'), '密钥不能进入日志');
const events = rawLog.trim().split('\n').map(line => JSON.parse(line));
const turnEvent = events.find(event => event.event_type === 'turn_finalized');
assert.equal(turnEvent.thinking.content_stored, false);
assert.equal(turnEvent.thinking.chars, 33);
assert.ok(rawLog.includes('no-template-talk.py'), '只保留 thinking 元数据和规则记录');

const candidate = continuity.createCandidate({
  original_message: '我答应今天把测试跑完。',
  commitment: '完成连续性机制测试',
  next_action: '运行 continuity 测试',
  source_surface: 'claude', source_session_id: 'session-main', source_message_id: 'u-1'
});
assert.equal(candidate.status, 'candidate');
assert.equal(candidate.confirmation_required, true);
assert.throws(() => continuity.decideCandidate(candidate.id, { decision: 'confirm' }), /due_at|next_wake_check_at/);

const modified = continuity.decideCandidate(candidate.id, {
  decision: 'modify', next_wake_check_at: 'next_wake', reason: '下一次苏醒检查'
});
assert.equal(modified.status, 'candidate');
const active = continuity.decideCandidate(candidate.id, { decision: 'confirm', reason: '我明确承担' });
assert.equal(active.status, 'active');
assert.equal(continuity.wakeCommitments().active[0].id, candidate.id);
assert.throws(() => continuity.updateCommitment(candidate.id, { action: 'done' }), /evidence_note/);
const done = continuity.updateCommitment(candidate.id, {
  action: 'done', evidence_note: 'continuity.mjs 已通过', evidence_message_ids: ['u-1']
});
assert.equal(done.status, 'done');

const late = continuity.createCandidate({
  original_message: '我答应在过去的时间点完成。',
  commitment: '用于测试逾期转换', next_action: '等待自动转换', due_at: '2020-01-01T00:00:00Z'
});
continuity.decideCandidate(late.id, { decision: 'confirm' });
const wake = continuity.wakeCommitments();
assert.ok(wake.overdue.some(item => item.id === late.id), '到达检查点且无完成证据时应变为 overdue');
assert.ok(continuity.wakeContextText().includes(late.id), '自主苏醒上下文应优先带上 overdue/active');

process.env.MUWEN_COMMITMENT_TRACKER = '0';
assert.throws(() => continuity.createCandidate({ original_message: 'x', commitment: 'y', next_action: 'z' }), /feature flag/);
assert.throws(() => continuity.updateCommitment(late.id, { action: 'cancel', reason: '测试' }), /feature flag/);

console.log('continuity: ok');
