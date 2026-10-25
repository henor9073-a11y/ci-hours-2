import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'window-workbench-test-'));
process.env.WINDOW_WAITING_IDLE_TIMEOUT_MS = '1000';
const ww = await import('../lib/window-workbench.js');
const workbenchUi = fs.readFileSync(new URL('../public/muwu.js', import.meta.url), 'utf8');
assert.match(workbenchUi, /wwTaskBar\(data, 'windows'\)/);
assert.match(workbenchUi, /wwTaskBar\(data, 'actions'\)/);
assert.doesNotMatch(workbenchUi, /if \(job\) h \+= wwJobCard\(job\);/);

const first = ww.getWorkbench();
assert.equal(first.active_job, null);
assert.equal(first.choices.models[0].id, 'claude-opus-4-6[1m]');
assert.ok(first.choices.models.every(model => model.id.endsWith('[1m]')));
assert.deepEqual(first.choices.crop_profiles.map(profile => profile.id), ['normal', 'economy', 'extreme']);
assert.deepEqual(first.choices.handover_templates.map(template => template.id), [
  'one-summary-22h', 'two-summaries-22h', 'one-summary-46h',
  'three-summaries', 'summaries-only', 'raw-only'
]);
assert.ok(first.choices.crop_profiles.every(profile => /原话.*承接资料/.test(profile.detail)));
assert.deepEqual(first.choices.models.map(model => model.id), [
  'claude-opus-4-6[1m]',
  'claude-sonnet-4-6[1m]',
  'claude-fable-5-1[1m]',
  'claude-opus-5-5[1m]',
  'claude-sonnet-5-5[1m]',
  'claude-haiku-5-5[1m]'
]);

const job = ww.createJob({ mode: 'handoff', model: 'not-allowed', thinking_display: 'summarized', preview_only: true });
assert.equal(job.status, 'queued');
assert.equal(job.disable_wake_on_prepare, true);
assert.match(job.message, /先关闭自主苏醒/);
assert.equal(job.model, 'claude-opus-4-6[1m]');
assert.equal(job.handover_contract.raw_dialogue_hours, 46);
assert.equal(job.handover_contract.recent_context_json_hours, 2);
assert.equal(job.handover_contract.version, 5);
assert.equal(job.handover_contract.conversation_endpoint, '/api/history/main-context?hours=48&recent_hours=2');
assert.equal(job.handover_contract.canonical_conversation_source, 'main');
assert.deepEqual(job.handover_contract.include_sources, ['muwu', 'claude']);
assert.deepEqual(job.handover_contract.exclude_sources, ['nursery']);
assert.ok(job.handover_contract.pipeline_consumers.includes('daily_summary'));
assert.equal(job.handover_contract.include_daily_summary, true);
assert.equal(job.handover_contract.daily_summary_rule, 'exact_day_before_raw_window');
assert.equal(job.handover_contract.include_claude_md, false);
assert.match(job.handover_contract.note, /对话原文／thinking／重要工具调用/);
assert.throws(() => ww.createJob({ mode: 'fresh' }), /正在进行/);

const primaryId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const activeId = '44444444-4444-4444-8444-444444444444';
ww.agentHeartbeat({ agent_id: 'mini', capabilities: ['force_stop', 'crop_same_session', 'wake_toggle', 'interrupt_window', 'resume_window', 'mcp_reconnect', 'mcp_toggle', 'not_allowed'], current: {
  session_id: primaryId, model: 'opus', context_percent: 27.4, state: 'idle', wake_enabled: true,
  wake_last_at: '2026-10-08T10:00:00+11:00', wake_last_check_at: '2026-10-08T10:04:00+11:00',
  wake_mode: 'chase', wake_count_today: 3, wake_next_interval_min: 5,
  watchdog: { installed: true, healthy: false, checked_at: '2026-10-08T10:05:00+11:00', problems: ['主要窗口没运行', 17] },
  daily_pipeline: { last_run_at: '2026-10-08T08:30:00+11:00', last_success_date: '2026-10-07', last_error_at: '2026-10-08 08:30:00', last_error_date: '2026-10-07', last_error: '一次失败' },
  usage: {
    fetched_at: '2026-10-12T10:29:06+00:00', plan_label: 'Max (5x)',
    limits: [
      { id: 'session:0', kind: 'session', label: '会话额度', percent: 7, resets_at: '2026-10-12T13:40:00+00:00', severity: 'normal', is_active: false },
      { id: 'weekly_all:1', kind: 'weekly_all', label: '每周 · 全部模型', percent: 95, resets_at: '2026-10-13T04:00:00+00:00', severity: 'critical', is_active: true }
    ],
    weekly_breakdown: [{ id: 'claude_code', label: 'Claude Code', percent: 100 }],
    extra_usage: { enabled: false, percent: 0 }
  },
  windows: [
    { session_id: primaryId, name: '主要窗口', model: 'claude-opus-4-6[1m]', is_primary: true, state: 'idle', context_percent: 27.4,
      crop_generation: 2, last_crop_at: '2026-10-08T02:00:00+11:00',
      control_available: true, control_actions: ['interrupt', 'remote_control', 'mcp_reconnect', 'mcp_reconnect_all', 'mcp_enable', 'mcp_disable'],
      mcp_checked_at: '2026-10-05T12:00:00+11:00', mcp_checking: false,
      mcp_servers: [
        { name: 'muwen', kind: 'http', status: 'connected', detail: '已连接' },
        { name: 'GPD', kind: 'connector', status: 'offline', detail: '连接失败 · HTTP 404' },
        { name: 'moomoo', kind: 'http', status: 'disabled', enabled: false, detail: '已由工具间关闭' },
        { name: '', kind: 'bad', status: 'bad', detail: 'drop me' }
      ] },
    { session_id: otherId, name: 'Opus 5.5', model: 'claude-opus-5-5[1m]', is_primary: false, state: 'offline', context_percent: 18,
      recent_messages: [{ speaker: 'nor', text: '还在吗', at: '2026-10-04T10:00:00+11:00' }, { speaker: 'bad', text: '不要' }] },
    { session_id: activeId, name: '并行窗口', model: 'claude-opus-4-6[1m]', is_primary: false, state: 'idle', context_percent: 12,
      control_available: true, control_actions: ['interrupt', 'remote_control', 'mcp_reconnect', 'mcp_reconnect_all'] }
  ]
} });
assert.equal(ww.getWorkbench().agent.current.windows.length, 3);
assert.deepEqual(ww.getWorkbench().agent.capabilities, ['force_stop', 'crop_same_session', 'wake_toggle', 'interrupt_window', 'resume_window', 'mcp_reconnect', 'mcp_toggle']);
assert.equal(ww.getWorkbench().agent.current.windows[0].crop_generation, 2);
assert.equal(ww.getWorkbench().agent.current.windows[0].last_crop_at, '2026-10-08T02:00:00+11:00');
assert.deepEqual(ww.getWorkbench().agent.current.windows[1].recent_messages.map(x => x.text), ['还在吗']);
assert.deepEqual(ww.getWorkbench().agent.current.windows[0].mcp_servers.map(x => [x.name, x.status, x.enabled]), [['muwen', 'connected', true], ['GPD', 'offline', true], ['moomoo', 'disabled', false]]);
assert.equal(ww.getWorkbench().agent.current.wake_mode, 'chase');
assert.equal(ww.getWorkbench().agent.current.wake_count_today, 3);
assert.equal(ww.getWorkbench().agent.current.watchdog.installed, true);
assert.deepEqual(ww.getWorkbench().agent.current.watchdog.problems, ['主要窗口没运行', '17']);
assert.equal(ww.getWorkbench().agent.current.daily_pipeline.last_success_date, '2026-10-07');
assert.equal(ww.getWorkbench().agent.current.daily_pipeline.last_error_date, '2026-10-07');
assert.equal(ww.getWorkbench().agent.current.usage.plan_label, 'Max (5x)');
assert.deepEqual(ww.getWorkbench().agent.current.usage.limits.map(x => [x.label, x.percent]), [['会话额度', 7], ['每周 · 全部模型', 95]]);
assert.deepEqual(ww.getWorkbench().agent.current.usage.weekly_breakdown.map(x => [x.label, x.percent]), [['Claude Code', 100]]);
assert.equal(ww.getWorkbench().agent.current.usage.extra_usage.enabled, false);
assert.equal(ww.getWorkbench().primary_history.length, 1);
assert.equal(ww.getWorkbench().primary_history[0].session_id, primaryId);
assert.equal(ww.getWorkbench().primary_history[0].window_name, '主要窗口');
assert.equal(ww.getWorkbench().primary_history[0].ended_at, null);
assert.deepEqual(ww.deliveryRoute(primaryId), {
  allowed: true, requested_session_id: primaryId, primary_session_id: primaryId, reason: null
});
assert.equal(ww.deliveryRoute(activeId).allowed, false);
assert.equal(ww.deliveryRoute(activeId).reason, 'not_primary');
assert.equal(ww.deliveryRoute('').reason, 'session_required');
const claimed = ww.claimJob('mini');
assert.equal(claimed.id, job.id);
assert.equal(claimed.status, 'running');
assert.match(claimed.message, /先关闭.*自主苏醒/);

ww.updateJob(job.id, { phase: 'summarizing', progress: 52, message: '整理 46 小时', packet_preview: {
  older_22h: { narrative: '完整原话', records: 12 },
  last_two_hours: { records: 8 }
} });
const done = ww.completeJob(job.id, { message: '预览好了', result: { preview_only: true } });
assert.equal(done.status, 'completed');
assert.equal(done.progress, 100);
assert.equal(ww.getWorkbench().active_job, null);
assert.equal(ww.getWorkbench().history[0].packet_preview.older_22h.narrative, '完整原话');
assert.equal(ww.getWorkbench().history[0].packet_preview.last_two_hours.records, 8);
assert.equal(ww.getWorkbench().choices.briefs[0].id, job.id);

const fresh = ww.createJob({ mode: 'fresh', preview_only: false });
assert.equal(fresh.mode, 'fresh');
assert.equal(fresh.disable_wake_on_prepare, false);
const cancelled = ww.cancelJob(fresh.id);
assert.equal(cancelled.status, 'cancelled');
assert.equal(ww.completeJob(fresh.id, { message: '晚到的完成回报' }).status, 'cancelled');
assert.equal(ww.getWorkbench().active_job, null);

assert.throws(() => ww.createJob({ mode: 'fresh', preview_only: true }), /没有交接包/);

const cropPreview = ww.createJob({ mode: 'crop', preview_only: true, crop_profile: 'economy' });
assert.equal(cropPreview.mode, 'crop');
assert.equal(cropPreview.disable_wake_on_prepare, true);
assert.match(cropPreview.message, /先关闭自主苏醒/);
assert.equal(cropPreview.crop_profile, 'economy');
assert.equal(cropPreview.target_session_id, primaryId);
assert.equal(cropPreview.source_session_id, primaryId);
assert.equal(cropPreview.type, 'window_crop');
ww.cancelJob(cropPreview.id);
const defaultCrop = ww.createJob({ mode: 'crop', preview_only: true, crop_profile: 'not-allowed' });
assert.equal(defaultCrop.crop_profile, 'normal');
ww.cancelJob(defaultCrop.id);

const nonPrimaryCrop = ww.createJob({ mode: 'crop', target_session_id: activeId, preview_only: true, crop_profile: 'economy' });
assert.equal(nonPrimaryCrop.target_session_id, activeId);
assert.equal(nonPrimaryCrop.source_session_id, activeId);
ww.cancelJob(nonPrimaryCrop.id);

const templateRecipe = ww.createJob({
  mode: 'handoff', source_session_id: activeId, preview_only: true,
  context_recipe: { mode: 'template', template_id: 'two-summaries-22h' }
});
assert.equal(templateRecipe.source_session_id, activeId);
assert.equal(templateRecipe.context_recipe.template_id, 'two-summaries-22h');
assert.equal(templateRecipe.context_recipe.daily_summaries.length, 2);
assert.equal(templateRecipe.context_recipe.raw_ranges[0].hours, 22);
assert.deepEqual(templateRecipe.context_recipe.exclude_sources, ['nursery']);
ww.cancelJob(templateRecipe.id);

const customRecipe = ww.createJob({
  mode: 'secondary', source_session_id: otherId,
  context_recipe: {
    mode: 'custom',
    daily_summaries: [{ date: '2026-10-20' }, { date: '2026-10-18' }],
    raw_ranges: [{
      from: '2026-10-20T00:00:00+11:00', to: '2026-10-21T12:00:00+11:00',
      sources: ['muwu', 'claude', 'nursery']
    }]
  }
});
assert.deepEqual(customRecipe.context_recipe.daily_summaries.map(item => item.date), ['2026-10-20', '2026-10-18']);
assert.deepEqual(customRecipe.context_recipe.raw_ranges[0].sources, ['muwu', 'claude']);
ww.cancelJob(customRecipe.id);
assert.throws(() => ww.createJob({ mode: 'handoff', context_recipe: { mode: 'custom' } }), /至少/);

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

const resume = ww.createJob({ mode: 'resume_window', target_session_id: otherId });
assert.equal(resume.mode, 'resume_window');
assert.equal(resume.target_session_id, otherId);
ww.cancelJob(resume.id);
const interrupt = ww.createJob({ mode: 'interrupt_window', target_session_id: primaryId });
assert.equal(interrupt.mode, 'interrupt_window');
ww.cancelJob(interrupt.id);
assert.throws(() => ww.createJob({ mode: 'interrupt_window', target_session_id: activeId }), /只有当前主要窗口/);
const reconnectMCP = ww.createJob({ mode: 'mcp_reconnect', target_session_id: primaryId, target_mcp_name: 'GPD' });
assert.equal(reconnectMCP.target_mcp_name, 'GPD');
ww.cancelJob(reconnectMCP.id);
const reconnectAll = ww.createJob({ mode: 'mcp_reconnect_all', target_session_id: primaryId });
assert.equal(reconnectAll.mode, 'mcp_reconnect_all');
ww.cancelJob(reconnectAll.id);
const disableMCP = ww.createJob({ mode: 'mcp_set_enabled', target_session_id: primaryId, target_mcp_name: 'muwen', mcp_enabled: false });
assert.equal(disableMCP.target_mcp_name, 'muwen');
assert.equal(disableMCP.mcp_enabled, false);
assert.match(disableMCP.message, /关闭/);
ww.cancelJob(disableMCP.id);
const enableMCP = ww.createJob({ mode: 'mcp_set_enabled', target_session_id: primaryId, target_mcp_name: 'moomoo', mcp_enabled: true });
assert.equal(enableMCP.mcp_enabled, true);
assert.match(enableMCP.message, /打开/);
ww.cancelJob(enableMCP.id);
assert.throws(() => ww.createJob({ mode: 'mcp_set_enabled', target_session_id: primaryId, target_mcp_name: 'muwen' }), /必须明确/);
assert.throws(() => ww.createJob({ mode: 'mcp_reconnect', target_session_id: primaryId, target_mcp_name: 'missing' }), /不在目标窗口/);

const dailySource = ww.createJob({ mode: 'handoff', older_22h_source: 'daily_export' });
assert.equal(dailySource.older_22h_source, 'daily_export');
ww.cancelJob(dailySource.id);
const customBrief = ww.createJob({ mode: 'handoff', brief_mode: 'custom', brief_id: job.id });
assert.equal(customBrief.brief_mode, 'custom');
assert.equal(customBrief.brief_id, job.id);
ww.cancelJob(customBrief.id);

const wakeOff = ww.createJob({ mode: 'set_wake', wake_enabled: false });
assert.equal(wakeOff.mode, 'set_wake');
assert.equal(wakeOff.type, 'window_setting');
assert.equal(wakeOff.wake_enabled, false);
assert.match(wakeOff.message, /关闭自主苏醒/);
ww.cancelJob(wakeOff.id);
const wakeOn = ww.createJob({ mode: 'set_wake', wake_enabled: true });
assert.equal(wakeOn.wake_enabled, true);
assert.match(wakeOn.message, /打开自主苏醒/);
ww.cancelJob(wakeOn.id);
assert.throws(() => ww.createJob({ mode: 'set_wake', wake_enabled: true, preview_only: true }), /不支持只生成预览/);

const waitsTooLong = ww.createJob({ mode: 'stop_window', target_session_id: activeId });
ww.claimJob('mini');
ww.updateJob(waitsTooLong.id, { status: 'waiting_idle', phase: 'waiting_idle', message: '等待窗口空闲' });
await new Promise(resolve => setTimeout(resolve, 1050));
const afterTimeout = ww.getWorkbench();
assert.equal(afterTimeout.active_job, null);
assert.equal(afterTimeout.history[0].status, 'failed');
assert.match(afterTimeout.history[0].error, /等待窗口空闲超过 5 分钟/);

const notice70 = ww.agentHeartbeat({ agent_id: 'mini', capabilities: ['force_stop', 'crop_same_session'], current: {
  session_id: primaryId, model: 'opus', context_percent: 70.2, state: 'idle', windows: []
} }).context_notice;
assert.equal(notice70.level, 70);
assert.equal(ww.agentHeartbeat({ agent_id: 'mini', capabilities: ['force_stop', 'crop_same_session'], current: {
  session_id: primaryId, model: 'opus', context_percent: 74, state: 'idle', windows: []
} }).context_notice, null);
const notice80 = ww.agentHeartbeat({ agent_id: 'mini', capabilities: ['force_stop', 'crop_same_session'], current: {
  session_id: primaryId, model: 'opus', context_percent: 80, state: 'idle', windows: []
} }).context_notice;
assert.equal(notice80.level, 80);
assert.equal(ww.agentHeartbeat({ agent_id: 'mini', capabilities: ['force_stop', 'crop_same_session'], current: {
  session_id: primaryId, model: 'opus', context_percent: 54, state: 'idle', windows: []
} }).context_notice, null);
assert.equal(ww.agentHeartbeat({ agent_id: 'mini', capabilities: ['force_stop', 'crop_same_session'], current: {
  session_id: primaryId, model: 'opus', context_percent: 71, state: 'idle', windows: []
} }).context_notice.level, 70);
assert.throws(() => ww.createJob({ mode: 'set_wake', wake_enabled: true }), /还没有接入正式执行器/);

// A channel that was already running before session-aware routing may finish
// its current lifetime without forcing a restart, but only while it is the
// sole online primary. The compatibility path closes as soon as another
// online window appears.
ww.agentHeartbeat({ agent_id: 'mini', capabilities: ['force_stop', 'crop_same_session', 'wake_toggle'], current: {
  session_id: primaryId, model: 'opus', context_percent: 71, state: 'idle', windows: [
    { session_id: primaryId, name: '主要窗口', model: 'claude-opus-4-6[1m]', is_primary: true, state: 'idle' }
  ]
} });
assert.equal(ww.deliveryRoute('').allowed, true);
ww.agentHeartbeat({ agent_id: 'mini', capabilities: ['force_stop', 'crop_same_session', 'wake_toggle'], current: {
  session_id: primaryId, model: 'opus', context_percent: 71, state: 'idle', windows: [
    { session_id: primaryId, name: '主要窗口', model: 'claude-opus-4-6[1m]', is_primary: true, state: 'idle' },
    { session_id: activeId, name: '并行窗口', model: 'claude-opus-4-6[1m]', is_primary: false, state: 'idle' }
  ]
} });
assert.equal(ww.deliveryRoute('').reason, 'session_required');

// Every session that was actually marked primary gets a dated tenure. This is
// the source of truth used by the daily transcript exporter; secondary windows
// never enter the history merely because they are online.
ww.agentHeartbeat({ agent_id: 'mini', capabilities: ['force_stop', 'crop_same_session', 'wake_toggle'], current: {
  session_id: otherId, model: 'opus', context_percent: 18, state: 'idle', windows: [
    { session_id: primaryId, name: '主要窗口', model: 'claude-opus-4-6[1m]', is_primary: false, state: 'idle' },
    { session_id: otherId, name: '小辞10.14', model: 'claude-opus-5-5[1m]', is_primary: true, state: 'idle' },
    { session_id: activeId, name: '并行窗口', model: 'claude-opus-4-6[1m]', is_primary: false, state: 'idle' }
  ]
} });
let primaryHistory = ww.getWorkbench().primary_history;
assert.equal(primaryHistory.length, 2);
assert.ok(primaryHistory[0].ended_at);
assert.equal(primaryHistory[1].session_id, otherId);
assert.equal(primaryHistory[1].window_name, '小辞10.14');
assert.equal(primaryHistory[1].ended_at, null);
ww.agentHeartbeat({ agent_id: 'mini', capabilities: ['force_stop', 'crop_same_session', 'wake_toggle'], current: {
  session_id: primaryId, model: 'opus', context_percent: 71, state: 'idle', windows: [
    { session_id: primaryId, name: '主要窗口', model: 'claude-opus-4-6[1m]', is_primary: true, state: 'idle' },
    { session_id: otherId, name: '小辞10.14', model: 'claude-opus-5-5[1m]', is_primary: false, state: 'idle' }
  ]
} });
primaryHistory = ww.getWorkbench().primary_history;
assert.equal(primaryHistory.length, 3);
assert.ok(primaryHistory[1].ended_at);
assert.equal(primaryHistory[2].session_id, primaryId);
assert.equal(primaryHistory[2].ended_at, null);
console.log('✓ 换窗工作台队列、白名单、状态更新与取消');
