import { file, readJSON, writeJSON, now } from './muwen/common.js';

const FILE = file('watch-health.json');

function cached() {
  return readJSON(FILE, null);
}

function numberAt(value, keys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of keys) {
    const raw = value[key];
    if (Number.isFinite(Number(raw))) return Number(raw);
    if (raw && typeof raw === 'object' && Number.isFinite(Number(raw.value))) return Number(raw.value);
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
    steps: numberAt(raw, ['steps', 'step_count', 'stepCount']),
    sleep: valueAt(raw, ['sleep', 'sleep_summary', 'sleepSummary']),
    raw
  };
}

export function ingestWatchHealth(payload, source = 'watch_relay_push') {
  const value = normalizeWatchHealth(payload, source);
  writeJSON(FILE, value);
  return value;
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
