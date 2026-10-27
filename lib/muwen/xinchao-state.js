import { file, now, readJSON, writeJSON, clamp } from './common.js';

const FILE = file('xinchao-state.json');
const STALE_AFTER_MS = 5 * 60 * 1000;
const DRIVE_KEYS = [
  'possess', 'monitor', 'share', 'libido', 'curiosity', 'boredom',
  'duty', 'reflection', 'grieve', 'anger', 'favored'
];

function text(value, max = 80) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, 0, 1) : fallback;
}

export function updateSnapshot(input = {}) {
  const consciousness = text(input.consciousness, 24);
  if (!consciousness) throw new Error('consciousness 不能为空');

  const drives = {};
  for (const key of DRIVE_KEYS) drives[key] = finite(input.drives?.[key]);

  const snapshot = {
    consciousness,
    emotion: {
      label: text(input.emotion?.label, 40) || '平静',
      valence: finite(input.emotion?.valence, 0.5),
      arousal: finite(input.emotion?.arousal, 0.3)
    },
    drives,
    source_updated_at: text(input.source_updated_at, 48) || null,
    received_at: now()
  };
  writeJSON(FILE, snapshot);
  return getSnapshot();
}

export function getSnapshot(at = new Date()) {
  const snapshot = readJSON(FILE, null);
  if (!snapshot) return { available: false, online: false, age_seconds: null };
  const received = Date.parse(snapshot.received_at || '');
  const ageMs = Number.isFinite(received) ? Math.max(0, at.getTime() - received) : Infinity;
  return {
    available: true,
    online: ageMs <= STALE_AFTER_MS,
    age_seconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
    ...snapshot
  };
}

