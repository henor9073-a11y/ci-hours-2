import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'window-workbench-test-'));
process.env.WINDOW_WAITING_IDLE_TIMEOUT_MS = '1000';
const ww = await import('../lib/window-workbench.js');

const first = ww.getWorkbench();
assert.equal(first.active_job, null);
assert.equal(first.choices.models[0].id, 'claude-opus-4-6[1m]');

const job = ww.createJob({ mode: 'handoff', model: 'not-allowed', thinking_display: 'summarized', preview_only: true });
assert.equal(job.status, 'queued');
assert.equal(job.model, 'claude-opus-4-6[1m]');
assert.equal(job.handover_contract.raw_dialogue_hours, 22);
assert.equal(job.handover_contract.recent_context_json_hours, 2);
assert.equal(job.handover_contract.include_daily_summary, false);
assert.equal(job.handover_contract.include_claude_md, false);
assert.throws(() => ww.createJob({ mode: 'fresh' }), /正在进行/);

const primaryId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const activeId = '44444444-4444-4444-8444-444444444444';
ww.agentHeartbeat({ agent_id: 'mini', capabilities: ['force_stop', 'not_allowed'], current: {
  session_id: primaryId, model: 'opus', context_percent: 27.4, state: 'idle', wake_enabled: true,
  windows: [
    { session_id: primaryId, name: '主要窗口', model: 'claude-opus-4-6[1m]', is_primary: true, state: 'idle', context_percent: 27.4,
      mcp_checked_at: '2026-10-05T12:00:00+11:00', mcp_checking: false,
      mcp_servers: [
        { name: 'muwen', kind: 'http', status: 'connected', detail: '已连接' },
        { name: 'GPD', kind: 'connector', status: 'offline', detail: '连接失败 · HTTP 404' },
        { name: '', kind: 'bad', status: 'bad', detail: 'drop me' }
      ] },
    { session_id: otherId, name: 'Opus 5.5', model: 'claude-opus-5-5[1m]', is_primary: false, state: 'offline', context_percent: 18,
      recent_messages: [{ speaker: 'nor', text: '还在吗', at: '2026-10-04T10:00:00+11:00' }, { speaker: 'bad', text: '不要' }] },
    { session_id: activeId, name: '并行窗口', model: 'claude-opus-4-6[1m]', is_primary: false, state: 'idle', context_percent: 12 }
  ]
} });
assert.equal(ww.getWorkbench().agent.current.windows.length, 3);
assert.deepEqual(ww.getWorkbench().agent.capabilities, ['force_stop']);
assert.deepEqual(ww.getWorkbench().agent.current.windows[1].recent_messages.map(x => x.text), ['还在吗']);
assert.deepEqual(ww.getWorkbench().agent.current.windows[0].mcp_servers.map(x => [x.name, x.status]), [['muwen', 'connected'], ['GPD', 'offline']]);
const claimed = ww.claimJob('mini');
assert.equal(claimed.id, job.id);
assert.equal(claimed.status, 'running');

ww.updateJob(job.id, { phase: 'summarizing', progress: 52, message: '整理 22 小时', packet_preview: {
  older_22h: { narrative: '完整原话', records: 12 },
  last_two_hours: { records: 8 }
} });
const done = ww.completeJob(job.id, { message: '预览好了', result: { preview_only: true } });
assert.equal(done.status, 'completed');
assert.equal(done.progress, 100);
assert.equal(ww.getWorkbench().active_job, null);
assert.equal(ww.getWorkbench().history[0].packet_preview.older_22h.narrative, '完整原话');
assert.equal(ww.getWorkbench().history[0].packet_preview.last_two_hours.records, 8);

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
const forceStop = ww.createJob({ mode: 'stop_window', target_session_id: activeId, force_stop: true });
assert.equal(forceStop.mode, 'stop_window');
assert.equal(forceStop.force_stop, true);
assert.match(forceStop.message, /强行停止/);
ww.cancelJob(forceStop.id);
const restore = ww.createJob({ mode: 'restore_window', target_session_id: otherId });
assert.equal(restore.mode, 'restore_window');
assert.equal(restore.model, 'claude-opus-5-5[1m]');
ww.cancelJob(restore.id);
assert.throws(() => ww.createJob({ mode: 'restore_window', target_session_id: activeId }), /已经在运行/);

const waitsTooLong = ww.createJob({ mode: 'stop_window', target_session_id: activeId });
ww.claimJob('mini');
ww.updateJob(waitsTooLong.id, { status: 'waiting_idle', phase: 'waiting_idle', message: '等待窗口空闲' });
await new Promise(resolve => setTimeout(resolve, 1050));
const afterTimeout = ww.getWorkbench();
assert.equal(afterTimeout.active_job, null);
assert.equal(afterTimeout.history[0].status, 'failed');
assert.match(afterTimeout.history[0].error, /等待窗口空闲超过 5 分钟/);
console.log('✓ 换窗工作台队列、白名单、状态更新与取消');
