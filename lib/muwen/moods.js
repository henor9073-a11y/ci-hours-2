import { file, readJSON, writeJSON, newId, now, todayStr, shiftDate } from './common.js';

// 心情记录。轻量级：一句话 + 时间戳，不分类不打标签。
const FILE = file('moods.json');
function load() { return readJSON(FILE, []); }
function save(list) { writeJSON(FILE, list); }

export function addMood(text) {
  if (!text || !String(text).trim()) throw new Error('text 不能为空');
  const list = load();
  const entry = { id: newId('m'), text: String(text).trim(), recorded_at: now(), date: todayStr() };
  list.push(entry);
  save(list);
  return entry;
}

export function getMoods({ from, to, limit = 50 } = {}) {
  let list = load();
  if (from) list = list.filter(m => (m.date || m.recorded_at.slice(0, 10)) >= from);
  if (to) list = list.filter(m => (m.date || m.recorded_at.slice(0, 10)) <= to);
  return list.slice(-limit).reverse();
}

export function getMoodTrend(days = 30) {
  const today = todayStr();
  const from = shiftDate(today, -(Math.max(1, days) - 1));
  const list = load().filter(m => (m.date || m.recorded_at.slice(0, 10)) >= from);
  const byDay = {};
  for (const m of list) {
    const d = m.date || m.recorded_at.slice(0, 10);
    (byDay[d] = byDay[d] || []).push({ time: m.recorded_at.slice(11, 16), text: m.text });
  }
  return { from, to: today, total: list.length, days: Object.keys(byDay).sort().map(d => ({ date: d, moods: byDay[d] })) };
}
