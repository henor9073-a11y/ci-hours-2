import fs from 'fs';
import path from 'path';
import { getState } from './store.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const SCHEDULE_FILE = path.join(DATA_DIR, 'schedule.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function newId() { return 'sc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function now() { return new Date().toISOString(); }

// 棋子的日程——不是永久循环重复的那种闹钟，是"某几天的某个时间点要做什么"，
// 一次能加好几天（每条自己带日期，不用共用同一个时间）。到点了服务器自己用
// server.js 里的 node-cron 每分钟检查一遍、直接推 Bark，不依赖辞醒没醒来。
// 辞醒来的时候也能读今天的日程（get_today_schedule），方便顺带看一眼、关心一下。

function validDate(d) { return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d); }
function validTime(t) { return typeof t === 'string' && /^\d{2}:\d{2}$/.test(t); }

export function addSchedule(entries) {
  const list = readJSON(SCHEDULE_FILE, []);
  const added = [];
  for (const e of (entries || [])) {
    if (!e || !validDate(e.date) || !validTime(e.time) || !e.text) continue;
    const entry = {
      id: newId(),
      date: e.date,
      time: e.time,
      text: e.text,
      status: 'pending', // pending / completed / removed
      pushed: false,
      createdAt: now(),
      updatedAt: now()
    };
    list.push(entry);
    added.push(entry);
  }
  writeJSON(SCHEDULE_FILE, list);
  return added;
}

export function getSchedule({ from, to, includeInactive = false } = {}) {
  const list = readJSON(SCHEDULE_FILE, []);
  return list
    .filter(x => includeInactive || x.status === 'pending')
    .filter(x => !from || x.date >= from)
    .filter(x => !to || x.date <= to)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

function todayStr(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

export function getTodaySchedule() {
  const state = getState();
  const today = todayStr(state.settings.timezone);
  return getSchedule({ from: today, to: today });
}

export function updateSchedule(id, patch = {}) {
  const list = readJSON(SCHEDULE_FILE, []);
  const x = list.find(s => s.id === id);
  if (!x) return null;
  if (patch.date !== undefined && validDate(patch.date)) x.date = patch.date;
  if (patch.time !== undefined && validTime(patch.time)) x.time = patch.time;
  if (patch.text !== undefined && patch.text) x.text = patch.text;
  // 改了日期或时间，就当作还没推过，让它能重新在新的时间点推一次。
  if (patch.date !== undefined || patch.time !== undefined) x.pushed = false;
  x.updatedAt = now();
  writeJSON(SCHEDULE_FILE, list);
  return x;
}

export function completeSchedule(id) {
  const list = readJSON(SCHEDULE_FILE, []);
  const x = list.find(s => s.id === id);
  if (!x) return null;
  x.status = 'completed';
  x.updatedAt = now();
  writeJSON(SCHEDULE_FILE, list);
  return x;
}

export function removeSchedule(id) {
  const list = readJSON(SCHEDULE_FILE, []);
  const x = list.find(s => s.id === id);
  if (!x) return null;
  x.status = 'removed';
  x.updatedAt = now();
  writeJSON(SCHEDULE_FILE, list);
  return x;
}

// ---- 给 server.js 里的 cron 用 ----
// 找出"日期+时间已经到了、但还没推过 Bark"的条目。用棋子设置的时区来判断"现在"。
export function getDueSchedules() {
  const state = getState();
  const tz = state.settings.timezone;
  const nowLocal = new Date().toLocaleString('sv', { timeZone: tz }); // "YYYY-MM-DD HH:MM:SS"
  const nowKey = nowLocal.slice(0, 16); // "YYYY-MM-DD HH:MM"
  const list = readJSON(SCHEDULE_FILE, []);
  return list.filter(x => x.status === 'pending' && !x.pushed && `${x.date} ${x.time}` <= nowKey);
}

export function markSchedulePushed(id) {
  const list = readJSON(SCHEDULE_FILE, []);
  const x = list.find(s => s.id === id);
  if (!x) return null;
  x.pushed = true;
  x.updatedAt = now();
  writeJSON(SCHEDULE_FILE, list);
  return x;
}

// ---- 给统一日历用的 ----
// 按月拿这个月的日程（pending + completed，不要 removed 的），给日历标点用。
export function getScheduleByMonth(month) {
  const list = readJSON(SCHEDULE_FILE, []);
  return list
    .filter(x => x.status !== 'removed' && x.date.startsWith(month))
    .map(x => ({ id: x.id, date: x.date, time: x.time, text: x.text, status: x.status }))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

// 拿某一天的日程（pending + completed），给日历点进某天的详情用。
export function getScheduleForDate(date) {
  const list = readJSON(SCHEDULE_FILE, []);
  return list
    .filter(x => x.status !== 'removed' && x.date === date)
    .map(x => ({ id: x.id, date: x.date, time: x.time, text: x.text, status: x.status }))
    .sort((a, b) => a.time.localeCompare(b.time));
}
