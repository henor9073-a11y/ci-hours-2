import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwen-continuity-test-'));
process.env.DATA_DIR = dataDir;
delete process.env.MUWEN_CONTINUITY_EVENT_LOG;
delete process.env.MUWEN_COMMITMENT_TRACKER;
delete process.env.MUWEN_COMMITMENT_SUGGESTIONS;
delete process.env.MUWEN_CONTINUITY_CONTENT_MODE;

const continuity = await import('../lib/muwen/continuity.js');

assert.deepEqual(continuity.featureFlags(), {
  event_log: true,
  commitment_tracker: true,
  commitment_suggestions: true,
  stable_stance: false,
  unresolved_conflict: false,
  shell_detection: false,
  content_mode: 'sanitized_text',
  event_log_policy: { retention_days: 30, archive_after_days: 7, max_file_bytes: 10 * 1024 * 1024 }
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

continuity.recordClaudeTurn({
  session_id: 'session-main', turn_id: 'turn-suggest', output_message_id: 'a-suggest',
  user_input: '你会处理吗？', content: '我现在就把部署状态检查清楚。'
}, { allowed: true, primary_session_id: 'session-main' });

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

const suggested = continuity.listCommitments({ statuses: ['suggested_candidate'] })[0];
assert.equal(suggested.status, 'suggested_candidate');
assert.equal(continuity.wakeCommitments().active.length, 0, '系统建议未经确认不能进入 active');
assert.match(continuity.pendingSuggestionContext({ session_id: 'session-main', mark_presented: true }), /不是已经建立的任务/);
assert.equal(continuity.pendingSuggestionContext({ session_id: 'session-main', mark_presented: true }), '', '普通回复只提示一次，苏醒仍能看到未决建议');
const editedSuggestion = continuity.decideSuggestion(suggested.id, {
  decision: 'modify', commitment: '核验部署状态', next_action: '读取线上状态端点', reason: '把动作写具体'
});
assert.equal(editedSuggestion.status, 'suggested_candidate');
assert.equal(editedSuggestion.confirmation_required, true);
const suggestionActive = continuity.decideSuggestion(suggested.id, { decision: 'confirm', reason: '我确认承担' });
assert.equal(suggestionActive.status, 'active');
const selfReported = continuity.updateCommitment(suggested.id, {
  action: 'done', evidence_type: 'self_reported', evidence_note: '我已经看过了'
});
assert.equal(selfReported.completion_evidence.label, '仅自述');
assert.equal(selfReported.completion_evidence.verification, 'self_reported_only');

continuity.recordClaudeTurn({
  session_id: 'session-main', turn_id: 'turn-old-window', output_message_id: 'a-old-window',
  content: '我答应把旧窗口兼容入口检查完。'
}, { allowed: true, primary_session_id: 'session-main' });
const oldWindowSuggestion = continuity.listCommitments({ statuses: ['suggested_candidate'] })
  .find(item => item.source?.message_id === 'a-old-window');
const oldWindowRejected = continuity.decideCandidate(oldWindowSuggestion.id, {
  decision: 'refuse', reason: '这只是测试语句，不构成真实承诺'
});
assert.equal(oldWindowRejected.status, 'rejected', '缓存旧工具列表的窗口仍能处理建议候选');

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
assert.throws(() => continuity.updateCommitment(candidate.id, { action: 'done' }), /evidence_type|evidence_note/);
const done = continuity.updateCommitment(candidate.id, {
  action: 'done', evidence_type: 'message_id', evidence_note: 'continuity.mjs 已通过', evidence_message_ids: ['u-1']
});
assert.equal(done.status, 'done');
assert.equal(done.completion_evidence.type, 'message_id');

const late = continuity.createCandidate({
  original_message: '我答应在过去的时间点完成。',
  commitment: '用于测试逾期转换', next_action: '等待自动转换', due_at: '2020-01-01T00:00:00Z'
});
continuity.decideCandidate(late.id, { decision: 'confirm' });
const wake = continuity.wakeCommitments();
assert.ok(wake.overdue.some(item => item.id === late.id), '到达检查点且无完成证据时应变为 overdue');
assert.ok(continuity.wakeContextText().includes(late.id), '自主苏醒上下文应优先带上 overdue/active');

const eventsDir = path.join(dataDir, 'continuity-events');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
function daysBefore(n) {
  const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10);
}
fs.writeFileSync(path.join(eventsDir, `${daysBefore(8)}.jsonl`), '{"event_type":"old"}\n');
fs.writeFileSync(path.join(eventsDir, `${daysBefore(3)}.jsonl`), '{"event_type":"archive"}\n');
process.env.MUWEN_CONTINUITY_EVENT_RETENTION_DAYS = '5';
process.env.MUWEN_CONTINUITY_EVENT_ARCHIVE_DAYS = '2';
const cleanup = continuity.cleanupEventLogs({ force: true });
assert.ok(cleanup.deleted.some(name => name.startsWith(daysBefore(8))));
assert.ok(cleanup.archived.some(name => name.startsWith(daysBefore(3))));
assert.ok(fs.existsSync(path.join(eventsDir, `${daysBefore(3)}.jsonl.gz`)));
process.env.MUWEN_CONTINUITY_EVENT_MAX_BYTES = '1024';
for (let i = 0; i < 4; i++) continuity.appendEvent({ event_type: 'rotation_test', payload: 'x'.repeat(900), index: i });
assert.ok(fs.readdirSync(eventsDir).some(name => name.includes('.part-')), '达到单文件上限后应分片轮转');

process.env.MUWEN_COMMITMENT_TRACKER = '0';
assert.throws(() => continuity.createCandidate({ original_message: 'x', commitment: 'y', next_action: 'z' }), /feature flag/);
assert.throws(() => continuity.updateCommitment(late.id, { action: 'cancel', reason: '测试' }), /feature flag/);

console.log('continuity: ok');
