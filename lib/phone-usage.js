import { file, readJSON, writeJSON, now, todayStr } from './muwen/common.js';

const FILE = file('phone-usage.json');

function store() {
  const value = readJSON(FILE, { version: 1, snapshots: {} });
  return {
    version: 1,
    snapshots: value && typeof value.snapshots === 'object' && value.snapshots ? value.snapshots : {}
  };
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanApp(value = {}) {
  return {
    name: String(value.name || value.display_name || value.bundle_id || '未知 App').trim().slice(0, 120),
    bundle_id: String(value.bundle_id || '').trim().slice(0, 200),
    duration_seconds: Math.max(0, Math.round(finite(value.duration_seconds))),
    pickups: Math.max(0, Math.round(finite(value.pickups))),
    notifications: Math.max(0, Math.round(finite(value.notifications)))
  };
}

export function ingestPhoneUsage(input = {}) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || '')) ? String(input.date) : todayStr();
  const apps = Array.isArray(input.apps) ? input.apps.map(cleanApp)
    .filter(app => app.duration_seconds > 0 || app.pickups > 0 || app.notifications > 0)
    .sort((a, b) => b.duration_seconds - a.duration_seconds).slice(0, 100) : [];
  const snapshot = {
    date,
    total_seconds: Math.max(0, Math.round(finite(input.total_seconds))),
    pickups: Math.max(0, Math.round(finite(input.pickups))),
    first_pickup_at: input.first_pickup_at ? String(input.first_pickup_at).slice(0, 80) : null,
    source_updated_at: input.source_updated_at ? String(input.source_updated_at).slice(0, 80) : null,
    source_device: String(input.source_device || 'sigh_ios_screen_time').slice(0, 80),
    apps,
    synced_at: now()
  };
  const value = store();
  value.snapshots[date] = snapshot;
  // 屏幕时间只保留最近 120 天，足够看近期规律，也避免文件无限增长。
  const dates = Object.keys(value.snapshots).sort().reverse();
  for (const old of dates.slice(120)) delete value.snapshots[old];
  writeJSON(FILE, value);
  return snapshot;
}

export function getPhoneUsage(date = '') {
  const value = store();
  if (date) return value.snapshots[date] || null;
  const latest = Object.keys(value.snapshots).sort().pop();
  return latest ? value.snapshots[latest] : null;
}
