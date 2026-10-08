import { file, readJSON, writeJSON, newId, now } from './muwen/common.js';

const DB = file('window-workbench.json');
const KEEP_JOBS = 20;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const WAITING_IDLE_TIMEOUT_MS = Math.max(1_000, Number(process.env.WINDOW_WAITING_IDLE_TIMEOUT_MS) || 5 * 60_000);
export const HANDOVER_CONTRACT = {
  version: 2,
  raw_dialogue_hours: 22,
  recent_context_json_hours: 2,
  include_daily_summary: false,
  include_claude_md: false,
  include_explanations: false,
  preserve_timestamps: true,
  load_normally: ['~/.claude/HOW-TO-NOR.md', '~/.claude/TOOLS.md'],
  note: '只交接原始对话和最近两小时上下文 JSON；不注入 CLAUDE.md，不加总结、标题或说明。'
};

export const WINDOW_MODELS = [
  { id: 'claude-opus-4-6[1m]', label: 'Opus 4.6 · 1M' },
  { id: 'claude-opus-5-5[1m]', label: 'Opus 5.5 · 1M' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6 · 200K' }
];
export const THINKING_DISPLAYS = [
  { id: 'summarized', label: '显示思考摘要' },
  { id: 'none', label: '不显示思考过程' }
];

function blank() {
  return { version: 1, agent: null, active_job_id: null, jobs: [] };
}

function load() {
  const s = readJSON(DB, blank());
  s.version = 1;
  s.agent = s.agent || null;
  s.active_job_id = s.active_job_id || null;
  s.jobs = Array.isArray(s.jobs) ? s.jobs : [];
  const active = s.jobs.find(j => j.id === s.active_job_id && !TERMINAL.has(j.status));
  let changed = false;
  if (s.active_job_id && !active) {
    s.active_job_id = null;
    changed = true;
  } else if (active && active.waiting_idle_since
      && Date.now() - new Date(active.waiting_idle_since).getTime() >= WAITING_IDLE_TIMEOUT_MS) {
    const at = now();
    active.status = 'failed';
    active.phase = 'failed';
    active.message = '窗口持续忙碌，任务已自动停止并解锁；没有改动任何窗口';
    active.error = '等待窗口空闲超过 5 分钟。请等它回复结束后再重试。';
    active.updated_at = at;
    active.finished_at = at;
    active.steps = [...(active.steps || []), { at, phase: 'failed', message: active.message }].slice(-40);
    delete active.lease_until;
    delete active.waiting_idle_since;
    s.active_job_id = null;
    changed = true;
  } else if (active && active.lease_until && new Date(active.lease_until).getTime() < Date.now()) {
    const at = now();
    active.status = 'failed';
    active.phase = 'failed';
    active.message = 'Mac mini 执行器停止报到，任务已自动解锁；没有改动任何窗口';
    active.error = '执行器租约已过期。可以确认 Mac mini 在线后重试。';
    active.updated_at = at;
    active.finished_at = at;
    active.steps = [...(active.steps || []), { at, phase: 'failed', message: active.message }].slice(-40);
    delete active.lease_until;
    s.active_job_id = null;
    changed = true;
  }
  if (changed) save(s);
  return s;
}

function save(s) {
  s.jobs = s.jobs.slice(-KEEP_JOBS);
  writeJSON(DB, s);
  return s;
}

function cleanLine(v, max = 240) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
}

function cleanSessionId(v) {
  const value = String(v || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function cleanRemoteUrl(v) {
  return /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+$/.test(String(v || '')) ? String(v) : null;
}

function cleanMcpServer(input = {}) {
  const name = cleanLine(input.name, 120);
  if (!name) return null;
  return {
    name,
    kind: ['connector', 'plugin', 'http', 'stdio'].includes(input.kind) ? input.kind : 'unknown',
    status: ['connected', 'offline', 'auth', 'unknown'].includes(input.status) ? input.status : 'unknown',
    detail: cleanLine(input.detail, 240) || null
  };
}

function cleanMcpServers(input) {
  return (Array.isArray(input) ? input : []).slice(0, 80).map(cleanMcpServer).filter(Boolean);
}

function cleanAgentCapabilities(input) {
  const allowed = new Set(['force_stop', 'crop_same_session']);
  return [...new Set((Array.isArray(input) ? input : []).map(String).filter(item => allowed.has(item)))];
}

function cleanWindow(input = {}) {
  const sessionId = cleanSessionId(input.session_id);
  if (!sessionId) return null;
  const recentMessages = (Array.isArray(input.recent_messages) ? input.recent_messages : []).slice(-10).map(message => {
    const speaker = message && ['nor', 'cy'].includes(message.speaker) ? message.speaker : null;
    const text = cleanLine(message && message.text, 1200);
    if (!speaker || !text) return null;
    return { speaker, text, at: cleanLine(message.at, 60) || null };
  }).filter(Boolean);
  return {
    session_id: sessionId,
    name: cleanLine(input.name || '未命名窗口', 80),
    model: cleanLine(input.model, 80) || null,
    thinking_display: ['summarized', 'none'].includes(input.thinking_display) ? input.thinking_display : 'summarized',
    is_primary: !!input.is_primary,
    state: ['idle', 'busy', 'offline', 'unknown'].includes(input.state) ? input.state : 'unknown',
    context_percent: Number.isFinite(Number(input.context_percent)) ? Math.max(0, Math.min(100, Number(input.context_percent))) : null,
    context_tokens: Number.isFinite(Number(input.context_tokens)) ? Math.max(0, Number(input.context_tokens)) : null,
    context_limit: Number.isFinite(Number(input.context_limit)) ? Math.max(1, Number(input.context_limit)) : null,
    created_at: cleanLine(input.created_at, 60) || null,
    last_activity_at: cleanLine(input.last_activity_at, 60) || null,
    remote_url: cleanRemoteUrl(input.remote_url),
    source_session_id: cleanSessionId(input.source_session_id),
    transcript_bytes: Number.isFinite(Number(input.transcript_bytes)) ? Math.max(0, Number(input.transcript_bytes)) : null,
    message_count: Number.isFinite(Number(input.message_count)) ? Math.max(0, Number(input.message_count)) : null,
    crop_generation: Number.isFinite(Number(input.crop_generation)) ? Math.max(0, Math.floor(Number(input.crop_generation))) : 0,
    last_crop_at: cleanLine(input.last_crop_at, 60) || null,
    mcp_servers: cleanMcpServers(input.mcp_servers),
    mcp_checked_at: cleanLine(input.mcp_checked_at, 60) || null,
    mcp_checking: !!input.mcp_checking,
    mcp_error: cleanLine(input.mcp_error, 300) || null,
    recent_messages: recentMessages
  };
}

function publicJob(j) {
  if (!j) return null;
  const { lease_until, claimed_by, ...out } = j;
  return out;
}

export function getWorkbench() {
  const s = load();
  const active = s.jobs.find(j => j.id === s.active_job_id) || null;
  return {
    agent: s.agent,
    active_job: publicJob(active),
    history: s.jobs.slice().reverse().filter(j => !active || j.id !== active.id).slice(0, 10).map(publicJob),
    choices: { models: WINDOW_MODELS, thinking_displays: THINKING_DISPLAYS }
  };
}

export function createJob(input = {}) {
  const s = load();
  const active = s.jobs.find(j => j.id === s.active_job_id && !TERMINAL.has(j.status));
  if (active) throw new Error('已经有一次换窗正在进行，请等它结束或先取消');

  const requestedMode = String(input.mode || 'handoff');
  const mode = ['crop', 'handoff', 'fresh', 'secondary', 'set_primary', 'stop_window', 'restore_window'].includes(requestedMode) ? requestedMode : 'handoff';
  const windows = Array.isArray(s.agent?.current?.windows) ? s.agent.current.windows : [];
  const primaryWindow = windows.find(w => w.is_primary) || null;
  const targetSessionId = cleanSessionId(input.target_session_id) || (mode === 'crop' ? primaryWindow?.session_id : null);
  const targetWindow = targetSessionId ? windows.find(w => w.session_id === targetSessionId) : null;
  if (['crop', 'set_primary', 'stop_window', 'restore_window'].includes(mode) && !targetWindow) {
    throw new Error('这个窗口不在 Mac mini 当前登记的窗口列表里');
  }
  if (mode === 'crop' && targetWindow.state === 'offline') throw new Error('这个窗口已经停止，不能原地裁剪');
  if (mode === 'crop' && !targetWindow.is_primary) throw new Error('同窗裁剪目前只对当前主要窗口开放');
  if (mode === 'crop' && !cleanAgentCapabilities(s.agent?.capabilities).includes('crop_same_session')) {
    throw new Error('Mac mini 的同窗裁剪执行器还没有通过安全验证');
  }
  if (mode === 'stop_window' && targetWindow.is_primary) throw new Error('主要窗口不能停止，请先把主要窗口切换到别的窗口');
  if (mode === 'stop_window' && targetWindow.state === 'offline') throw new Error('这个窗口已经停止了');
  if (mode === 'restore_window' && targetWindow.state !== 'offline') throw new Error('这个窗口已经在运行了');
  const requestedSource = cleanSessionId(input.source_session_id);
  const sourceWindow = requestedSource ? windows.find(w => w.session_id === requestedSource) : null;
  if (requestedSource && !sourceWindow) throw new Error('指定的来源窗口不在 Mac mini 当前登记的窗口列表里');
  const model = WINDOW_MODELS.some(x => x.id === input.model) ? input.model : WINDOW_MODELS[0].id;
  const targetModel = targetWindow && WINDOW_MODELS.some(x => x.id === targetWindow.model) ? targetWindow.model : model;
  const resolvedModel = ['crop', 'set_primary', 'stop_window', 'restore_window'].includes(mode) ? targetModel : model;
  const thinking = THINKING_DISPLAYS.some(x => x.id === input.thinking_display)
    ? input.thinking_display : THINKING_DISPLAYS[0].id;
  const resolvedThinking = ['crop', 'set_primary', 'stop_window', 'restore_window'].includes(mode) ? (targetWindow.thinking_display || thinking) : thinking;
  const forceStop = mode === 'stop_window' && input.force_stop === true;
  if (forceStop && !cleanAgentCapabilities(s.agent?.capabilities).includes('force_stop')) {
    throw new Error('Mac mini 的换窗执行器还没更新，暂时不能强行停止');
  }
  const previewOnly = !!input.preview_only;
  if (previewOnly && mode === 'fresh') throw new Error('全新窗口没有交接包可以预览');
  if (previewOnly && ['secondary', 'set_primary', 'stop_window', 'restore_window'].includes(mode)) throw new Error('这个操作不支持只生成预览');

  const at = now();
  const queuedMessage = mode === 'set_primary'
    ? `已排队，准备把「${targetWindow.name}」设为主要窗口`
    : mode === 'stop_window'
      ? `已排队，准备停止「${targetWindow.name}」；会话记录不会删除`
      : mode === 'restore_window'
        ? `已排队，准备恢复「${targetWindow.name}」`
      : mode === 'crop'
        ? (previewOnly ? '已排队，准备生成同窗裁剪预览' : `已排队，准备安全裁剪「${targetWindow.name}」`)
    : mode === 'secondary'
      ? '已排队，准备创建并行窗口'
      : previewOnly ? '已排队，等待生成交接预览' : '已排队，等待 Mac mini 接单';
  const job = {
    id: newId('wj_'),
    type: mode === 'crop' ? 'window_crop' : 'window_switch',
    mode,
    model: resolvedModel,
    thinking_display: resolvedThinking,
    source_session_id: sourceWindow?.session_id || (mode === 'crop' ? targetWindow?.session_id : null),
    target_session_id: targetWindow?.session_id || null,
    target_name: targetWindow?.name || null,
    force_stop: forceStop,
    preview_only: previewOnly,
    status: 'queued',
    phase: 'queued',
    progress: 0,
    message: forceStop ? `已排队，准备强行停止「${targetWindow.name}」；会打断当前回复，但记录不会删除` : queuedMessage,
    steps: [{ at, phase: 'queued', message: '任务已安全写入队列' }],
    packet_preview: null,
    result: null,
    error: null,
    handover_contract: ['handoff', 'secondary'].includes(mode) ? HANDOVER_CONTRACT : null,
    requested_at: at,
    updated_at: at
  };
  s.jobs.push(job);
  s.active_job_id = job.id;
  save(s);
  return publicJob(job);
}

export function cancelJob(id) {
  const s = load();
  const job = s.jobs.find(j => j.id === id);
  if (!job) throw new Error('找不到这次换窗');
  if (TERMINAL.has(job.status)) return publicJob(job);
  job.status = 'cancelled';
  job.phase = 'cancelled';
  job.message = '已取消';
  job.updated_at = now();
  job.steps = [...(job.steps || []), { at: job.updated_at, phase: 'cancelled', message: '棋子取消了这次任务' }].slice(-40);
  if (s.active_job_id === id) s.active_job_id = null;
  save(s);
  return publicJob(job);
}

export function agentHeartbeat(body = {}) {
  const s = load();
  const current = body.current && typeof body.current === 'object' ? body.current : {};
  s.agent = {
    id: cleanLine(body.agent_id || 'mac-mini', 80),
    connected: true,
    seen_at: now(),
    capabilities: cleanAgentCapabilities(body.capabilities),
    current: {
      session_id: cleanLine(current.session_id, 80) || null,
      model: cleanLine(current.model, 80) || null,
      context_percent: Number.isFinite(Number(current.context_percent)) ? Math.max(0, Math.min(100, Number(current.context_percent))) : null,
      context_tokens: Number.isFinite(Number(current.context_tokens)) ? Math.max(0, Number(current.context_tokens)) : null,
      context_limit: Number.isFinite(Number(current.context_limit)) ? Math.max(1, Number(current.context_limit)) : null,
      state: ['idle', 'busy', 'offline', 'unknown'].includes(current.state) ? current.state : 'unknown',
      created_at: cleanLine(current.created_at, 60) || null,
      last_activity_at: cleanLine(current.last_activity_at, 60) || null,
      remote_url: cleanRemoteUrl(current.remote_url),
      wake_enabled: !!current.wake_enabled,
      wake_last_at: cleanLine(current.wake_last_at, 60) || null,
      mcp_servers: cleanMcpServers(current.mcp_servers),
      mcp_checked_at: cleanLine(current.mcp_checked_at, 60) || null,
      mcp_checking: !!current.mcp_checking,
      mcp_error: cleanLine(current.mcp_error, 300) || null,
      windows: (Array.isArray(current.windows) ? current.windows : []).slice(0, 80).map(cleanWindow).filter(Boolean)
    }
  };
  save(s);
  return { ok: true };
}

export function claimJob(agentId = 'mac-mini') {
  const s = load();
  const job = s.jobs.find(j => j.id === s.active_job_id && j.status === 'queued');
  if (!job) return null;
  const at = now();
  job.status = 'running';
  job.phase = 'inspecting';
  job.progress = 3;
  job.message = 'Mac mini 已接单，正在核对当前主窗口';
  job.claimed_by = cleanLine(agentId, 80);
  job.lease_until = new Date(Date.now() + 15 * 60_000).toISOString();
  job.updated_at = at;
  job.steps = [...(job.steps || []), { at, phase: job.phase, message: job.message }].slice(-40);
  save(s);
  return { ...publicJob(job), lease_until: job.lease_until };
}

function update(id, patch = {}, terminalStatus = null) {
  const s = load();
  const job = s.jobs.find(j => j.id === id);
  if (!job) throw new Error('找不到这次换窗');
  // 取消是最终决定。后台模型可能正卡在一个无法中断的长请求里，晚到的
  // progress/complete/fail 都不能把 cancelled 又覆盖成 completed。
  if (TERMINAL.has(job.status)) return publicJob(job);

  const at = now();
  const enteringWaitingIdle = patch.status === 'waiting_idle' || patch.phase === 'waiting_idle';
  if (enteringWaitingIdle && !job.waiting_idle_since) job.waiting_idle_since = at;
  if (enteringWaitingIdle && Date.now() - new Date(job.waiting_idle_since).getTime() >= WAITING_IDLE_TIMEOUT_MS) {
    job.status = 'failed';
    job.phase = 'failed';
    job.message = '窗口持续忙碌，任务已自动停止并解锁；没有改动任何窗口';
    job.error = '等待窗口空闲超过 5 分钟。请等它回复结束后再重试。';
    job.updated_at = at;
    job.finished_at = at;
    job.steps = [...(job.steps || []), { at, phase: 'failed', message: job.message }].slice(-40);
    delete job.lease_until;
    delete job.waiting_idle_since;
    if (s.active_job_id === id) s.active_job_id = null;
    save(s);
    return publicJob(job);
  }
  if (terminalStatus) job.status = terminalStatus;
  else if (patch.status && ['running', 'waiting_idle', 'validating'].includes(patch.status)) job.status = patch.status;
  if (patch.phase) job.phase = cleanLine(patch.phase, 80);
  if (patch.message) job.message = cleanLine(patch.message, 500);
  if (Number.isFinite(Number(patch.progress))) job.progress = Math.max(job.progress || 0, Math.min(100, Number(patch.progress)));
  if (patch.packet_preview && typeof patch.packet_preview === 'object') {
    const raw = JSON.stringify(patch.packet_preview);
    if (raw.length > 500_000) throw new Error('交接预览太大');
    job.packet_preview = patch.packet_preview;
  }
  if (patch.result && typeof patch.result === 'object') job.result = patch.result;
  if (patch.error) job.error = cleanLine(patch.error, 2000);
  job.updated_at = at;
  if (!terminalStatus) job.lease_until = new Date(Date.now() + 15 * 60_000).toISOString();
  const stepMessage = patch.step || patch.message;
  if (stepMessage) job.steps = [...(job.steps || []), { at, phase: job.phase, message: cleanLine(stepMessage, 500) }].slice(-40);
  if (terminalStatus) {
    job.progress = terminalStatus === 'completed' ? 100 : job.progress;
    job.phase = terminalStatus;
    job.message = patch.message || (terminalStatus === 'completed' ? '完成' : '失败');
    job.finished_at = at;
    delete job.lease_until;
    delete job.waiting_idle_since;
    if (s.active_job_id === id) s.active_job_id = null;
  }
  save(s);
  return publicJob(job);
}

export function updateJob(id, patch) { return update(id, patch); }
export function completeJob(id, patch) { return update(id, patch, 'completed'); }
export function failJob(id, patch) { return update(id, patch, 'failed'); }
