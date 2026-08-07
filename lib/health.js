import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';
const CYCLE_FILE = path.join(DATA_DIR, 'health-cycle.json');
const SLEEP_FILE = path.join(DATA_DIR, 'health-sleep.json');
const NOTES_FILE = path.join(DATA_DIR, 'health-notes.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function now() { return new Date().toISOString(); }
function validDate(d) { return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d); }
function validTime(t) { return typeof t === 'string' && /^\d{2}:\d{2}$/.test(t); }

// 棋子的健康数据——三类，都是棋子和辞都能记、都能改的，不是只读的。
// 单独存三个文件（不混进 memory.json），因为这是"数据记录"不是"记忆"，
// 性质不一样，不用拼进辞的身份文本里。

// ---------- 1. 生理周期记录 ----------
export function addCycleEntry({ date, note = '' }) {
  if (!validDate(date)) throw new Error('date 要是 YYYY-MM-DD');
  const list = readJSON(CYCLE_FILE, []);
  const entry = { id: newId('cy'), date, note, status: 'active', createdAt: now(), updatedAt: now() };
  list.push(entry);
  writeJSON(CYCLE_FILE, list);
  return entry;
}
export function getCycleEntries(limit = 30) {
  const list = readJSON(CYCLE_FILE, []).filter(x => x.status !== 'removed');
  return list.slice(-limit).reverse();
}
export function updateCycleEntry(id, patch = {}) {
  const list = readJSON(CYCLE_FILE, []);
  const x = list.find(e => e.id === id);
  if (!x) return null;
  if (patch.date !== undefined && validDate(patch.date)) x.date = patch.date;
  if (patch.note !== undefined) x.note = patch.note;
  x.updatedAt = now();
  writeJSON(CYCLE_FILE, list);
  return x;
}
export function removeCycleEntry(id) {
  const list = readJSON(CYCLE_FILE, []);
  const x = list.find(e => e.id === id);
  if (!x) return null;
  x.status = 'removed';
  x.updatedAt = now();
  writeJSON(CYCLE_FILE, list);
  return x;
}

// ---------- 2. 睡眠记录：记入睡/起床时间，自动算时长 ----------
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function computeDuration(sleepTime, wakeTime) {
  const s = toMinutes(sleepTime);
  const w = toMinutes(wakeTime);
  let mins = w - s;
  if (mins <= 0) mins += 24 * 60; // 跨天：晚上睡、第二天起，是最常见的情况
  return mins;
}
function formatDuration(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}小时${m}分` : `${h}小时`;
}

export function addSleepEntry({ date, sleepTime, wakeTime, note = '' }) {
  if (!validDate(date)) throw new Error('date 要是 YYYY-MM-DD（记的是起床那天的日期）');
  if (!validTime(sleepTime) || !validTime(wakeTime)) throw new Error('sleepTime/wakeTime 要是 HH:MM');
  const durationMinutes = computeDuration(sleepTime, wakeTime);
  const list = readJSON(SLEEP_FILE, []);
  const entry = {
    id: newId('sl'), date, sleepTime, wakeTime, durationMinutes,
    durationText: formatDuration(durationMinutes), note,
    status: 'active', createdAt: now(), updatedAt: now()
  };
  list.push(entry);
  writeJSON(SLEEP_FILE, list);
  return entry;
}
export function getSleepEntries(limit = 30) {
  const list = readJSON(SLEEP_FILE, []).filter(x => x.status !== 'removed');
  return list.slice(-limit).reverse();
}
export function updateSleepEntry(id, patch = {}) {
  const list = readJSON(SLEEP_FILE, []);
  const x = list.find(e => e.id === id);
  if (!x) return null;
  if (patch.date !== undefined && validDate(patch.date)) x.date = patch.date;
  if (patch.sleepTime !== undefined && validTime(patch.sleepTime)) x.sleepTime = patch.sleepTime;
  if (patch.wakeTime !== undefined && validTime(patch.wakeTime)) x.wakeTime = patch.wakeTime;
  if (patch.note !== undefined) x.note = patch.note;
  x.durationMinutes = computeDuration(x.sleepTime, x.wakeTime);
  x.durationText = formatDuration(x.durationMinutes);
  x.updatedAt = now();
  writeJSON(SLEEP_FILE, list);
  return x;
}
export function removeSleepEntry(id) {
  const list = readJSON(SLEEP_FILE, []);
  const x = list.find(e => e.id === id);
  if (!x) return null;
  x.status = 'removed';
  x.updatedAt = now();
  writeJSON(SLEEP_FILE, list);
  return x;
}

// ---------- 3. 身体状况备注（头晕、腰酸之类的） ----------
export function addHealthNote({ date, text }) {
  if (!validDate(date)) throw new Error('date 要是 YYYY-MM-DD');
  if (!text) throw new Error('text 是必填的');
  const list = readJSON(NOTES_FILE, []);
  const entry = { id: newId('hn'), date, text, status: 'active', createdAt: now(), updatedAt: now() };
  list.push(entry);
  writeJSON(NOTES_FILE, list);
  return entry;
}
export function getHealthNotes(limit = 30) {
  const list = readJSON(NOTES_FILE, []).filter(x => x.status !== 'removed');
  return list.slice(-limit).reverse();
}
export function updateHealthNote(id, patch = {}) {
  const list = readJSON(NOTES_FILE, []);
  const x = list.find(e => e.id === id);
  if (!x) return null;
  if (patch.date !== undefined && validDate(patch.date)) x.date = patch.date;
  if (patch.text !== undefined && patch.text) x.text = patch.text;
  x.updatedAt = now();
  writeJSON(NOTES_FILE, list);
  return x;
}
export function removeHealthNote(id) {
  const list = readJSON(NOTES_FILE, []);
  const x = list.find(e => e.id === id);
  if (!x) return null;
  x.status = 'removed';
  x.updatedAt = now();
  writeJSON(NOTES_FILE, list);
  return x;
}
