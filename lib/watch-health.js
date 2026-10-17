import { file, readJSON, writeJSON, newId, now } from './muwen/common.js';

const FILE = file('watch-health.json');
const EVENTS_FILE = file('watch-events.json');
const ACTIONS_FILE = file('watch-actions.json');

function cached() {
  return readJSON(FILE, null);
}

function events() { return readJSON(EVENTS_FILE, []); }
function actions() { return readJSON(ACTIONS_FILE, []); }

function recordEvent(direction, status, detail, actionId = '') {
  const list = events();
  const latest = list[list.length - 1];
  // 二十秒一次的正常快照不刷屏；变化、失败和手动动作仍逐条保留。
  if (!actionId && latest?.direction === direction && latest?.status === status && latest?.detail === detail
      && Date.now() - Date.parse(latest.at || '') < 5 * 60_000) return latest;
  const event = { id: newId('we_'), direction, status, detail, action_id: actionId || undefined, at: now() };
  list.push(event);
  writeJSON(EVENTS_FILE, list.slice(-200));
  return event;
}

function numberAt(value, keys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of keys) {
    const raw = value[key];
    if (raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw))) return Number(raw);
    if (raw && typeof raw === 'object' && raw.value !== null && raw.value !== undefined && raw.value !== '' && Number.isFinite(Number(raw.value))) return Number(raw.value);
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      const found = numberAt(child, keys);
      if (found !== null) return found;
    }
  }
  return null;
}

function valueAt(value, keys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of keys) if (value[key] !== undefined && value[key] !== null) return value[key];
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      const found = valueAt(child, keys);
      if (found !== null) return found;
    }
  }
  return null;
}

export function normalizeWatchHealth(payload, source = 'watch_relay') {
  const raw = payload && typeof payload === 'object' ? payload : {};
  return {
    source,
    fetched_at: now(),
    heart_rate_bpm: numberAt(raw, ['heart_rate_bpm', 'heartRate', 'heart_rate', 'bpm']),
    blood_oxygen_percent: numberAt(raw, ['blood_oxygen_percent', 'bloodOxygen', 'blood_oxygen', 'spo2', 'oxygen']),
    hrv_ms: numberAt(raw, ['hrv_ms', 'hrv', 'heartRateVariability', 'heart_rate_variability_sdnn']),
    steps: numberAt(raw, ['steps', 'step_count', 'stepCount']),
    active_energy_kcal: numberAt(raw, ['active_energy_kcal', 'activeEnergy', 'active_energy']),
    sleep: valueAt(raw, ['sleep', 'sleep_summary', 'sleepSummary']),
    raw
  };
}

export function ingestWatchHealth(payload, source = 'watch_relay_push') {
  const value = normalizeWatchHealth(payload, source);
  writeJSON(FILE, value);
  recordEvent('watch_to_muwu', 'ok', '手表健康快照已同步');
  return value;
}

export function getWatchStatus() {
  const snapshot = cached();
  const age = snapshot?.fetched_at ? Date.now() - Date.parse(snapshot.fetched_at) : Infinity;
  const connected = Number.isFinite(age) && age < 90_000;
  const pending = actions().filter(x => x.status === 'pending');
  return {
    connected,
    state: connected ? 'connected' : snapshot ? 'stale' : 'never_connected',
    checked_at: now(),
    last_seen_at: snapshot?.fetched_at || null,
    snapshot: snapshot || null,
    pending_actions: pending.length,
    events: events().slice(-100).reverse()
  };
}

export function requestWatchRefresh() {
  const list = actions();
  const existing = list.find(x => x.status === 'pending' && x.kind === 'refresh');
  if (existing) return existing;
  const action = { id: newId('wa_'), kind: 'refresh', status: 'pending', created_at: now() };
  list.push(action);
  writeJSON(ACTIONS_FILE, list.slice(-100));
  recordEvent('muwu_to_watch', 'pending', '请求手表 relay 立即刷新并尝试重连', action.id);
  return action;
}

export function pendingWatchActions(limit = 20) {
  return { actions: actions().filter(x => x.status === 'pending').slice(0, Math.max(1, Math.min(Number(limit) || 20, 100))) };
}

export function completeWatchAction(id, result = {}) {
  const list = actions();
  const action = list.find(x => x.id === id);
  if (!action) return null;
  action.status = result.ok === false ? 'failed' : 'done';
  action.completed_at = now();
  action.error = result.error ? String(result.error).slice(0, 300) : '';
  writeJSON(ACTIONS_FILE, list);
  recordEvent('watch_to_muwu', action.status === 'done' ? 'ok' : 'failed',
    action.status === 'done' ? '手表 relay 已回应，刷新完成' : `手表 relay 刷新失败：${action.error || '无法连接'}`, action.id);
  return action;
}

export async function getWatchHealth({ refresh = true } = {}) {
  if (!refresh) return cached() || { source: 'none', fetched_at: null, note: '还没有手表健康数据' };
  const url = process.env.WATCH_RELAY_URL;
  if (!url) return cached() || { source: 'none', fetched_at: null, note: '还没有从 Mac mini 收到手表健康数据' };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return ingestWatchHealth(await response.json(), 'watch_relay');
  } catch (error) {
    const value = cached();
    if (value) return { ...value, stale: true, refresh_error: String(error.message || error) };
    return { source: 'none', fetched_at: null, stale: true, refresh_error: String(error.message || error), note: '还没有从手表 relay 收到健康数据' };
  }
}
