import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'window-workbench-test-'));
const ww = await import('../lib/window-workbench.js');

const first = ww.getWorkbench();
assert.equal(first.active_job, null);
assert.equal(first.choices.models[0].id, 'claude-opus-4-6[1m]');

const job = ww.createJob({ mode: 'handoff', model: 'not-allowed', thinking_display: 'summarized', preview_only: true });
assert.equal(job.status, 'queued');
assert.equal(job.model, 'claude-opus-4-6[1m]');
assert.throws(() => ww.createJob({ mode: 'fresh' }), /正在进行/);

const primaryId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const activeId = '44444444-4444-4444-8444-444444444444';
ww.agentHeartbeat({ agent_id: 'mini', current: {
  session_id: primaryId, model: 'opus', context_percent: 27.4, state: 'idle', wake_enabled: true,
  windows: [
    { session_id: primaryId, name: '主要窗口', model: 'claude-opus-4-6[1m]', is_primary: true, state: 'idle', context_percent: 27.4 },
    { session_id: otherId, name: 'Opus 5.5', model: 'claude-opus-5-5[1m]', is_primary: false, state: 'offline', context_percent: 18,
      recent_messages: [{ speaker: 'nor', text: '还在吗', at: '2026-10-04T10:00:00+11:00' }, { speaker: 'bad', text: '不要' }] },
    { session_id: activeId, name: '并行窗口', model: 'claude-opus-4-6[1m]', is_primary: false, state: 'idle', context_percent: 12 }
  ]
} });
assert.equal(ww.getWorkbench().agent.current.windows.length, 3);
assert.deepEqual(ww.getWorkbench().agent.current.windows[1].recent_messages.map(x => x.text), ['还在吗']);
const claimed = ww.claimJob('mini');
assert.equal(claimed.id, job.id);
assert.equal(claimed.status, 'running');

ww.updateJob(job.id, { phase: 'summarizing', progress: 52, message: '整理 22 小时', packet_preview: { previous_daily: { body: '昨天' } } });
const done = ww.completeJob(job.id, { message: '预览好了', result: { preview_only: true } });
assert.equal(done.status, 'completed');
assert.equal(done.progress, 100);
assert.equal(ww.getWorkbench().active_job, null);
assert.equal(ww.getWorkbench().history[0].packet_preview.previous_daily.body, '昨天');

const fresh = ww.createJob({ mode: 'fresh', preview_only: false });
assert.equal(fresh.mode, 'fresh');
const cancelled = ww.cancelJob(fresh.id);
assert.equal(cancelled.status, 'cancelled');
assert.equal(ww.completeJob(fresh.id, { message: '晚到的完成回报' }).status, 'cancelled');
assert.equal(ww.getWorkbench().active_job, null);

assert.throws(() => ww.createJob({ mode: 'fresh', preview_only: true }), /没有交接包/);

const promote = ww.createJob({ mode: 'set_primary', target_session_id: otherId });
assert.equal(promote.mode, 'set_primary');
assert.equal(promote.target_session_id, otherId);
assert.equal(promote.model, 'claude-opus-5-5[1m]');
ww.cancelJob(promote.id);
assert.throws(() => ww.createJob({ mode: 'set_primary', target_session_id: '33333333-3333-4333-8333-333333333333' }), /不在 Mac mini/);

const secondary = ww.createJob({ mode: 'secondary', model: 'claude-opus-5-5[1m]', source_session_id: primaryId });
assert.equal(secondary.mode, 'secondary');
assert.equal(secondary.source_session_id, primaryId);
ww.cancelJob(secondary.id);

assert.throws(() => ww.createJob({ mode: 'stop_window', target_session_id: primaryId }), /主要窗口不能停止/);
assert.throws(() => ww.createJob({ mode: 'stop_window', target_session_id: otherId }), /已经停止/);
const stop = ww.createJob({ mode: 'stop_window', target_session_id: activeId });
assert.equal(stop.mode, 'stop_window');
assert.equal(stop.target_session_id, activeId);
assert.equal(stop.target_name, '并行窗口');
ww.cancelJob(stop.id);
const restore = ww.createJob({ mode: 'restore_window', target_session_id: otherId });
assert.equal(restore.mode, 'restore_window');
assert.equal(restore.model, 'claude-opus-5-5[1m]');
ww.cancelJob(restore.id);
assert.throws(() => ww.createJob({ mode: 'restore_window', target_session_id: activeId }), /已经在运行/);
console.log('✓ 换窗工作台队列、白名单、状态更新与取消');
