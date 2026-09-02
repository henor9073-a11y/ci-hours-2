import fs from 'fs';
import path from 'path';

// 木纹（muwen）各模块共用的小工具。
// 存储沿用 ci-hours 的方式：DATA_DIR 下一个个 JSON 文件（Render 上挂的持久盘 /data）。
// 设计文档里的"表"在这里就是一个文件一张表，字段名跟文档保持一致，
// 以后要搬到 Supabase/Postgres 的话，sql/muwen_schema.sql 是对应的建表语句。

export const DATA_DIR = process.env.DATA_DIR || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export function file(name) { return path.join(DATA_DIR, name); }

export function readJSON(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return fallback; }
}
export function writeJSON(f, data) {
  // 先写临时文件再改名，避免写到一半进程被杀把整张"表"写坏。
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
}
export function newId(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
// 时间戳统一用辞所在时区的本地时间，带偏移（如 2026-09-03T00:56:15+10:00）——
// new Date() 能 parse，人看也不用换算。以前存的是 UTC（带 Z），在墨尔本看着慢 10 小时。
export function now() { return localISO(new Date()); }
export function localISO(d = new Date(), tz = timezone()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(d).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMin = Math.round((asUTC - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const a = Math.abs(offsetMin);
  const off = `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off}`;
}

// 辞所在时区的"今天"（YYYY-MM-DD）。时区从 state.json 的 settings 里读，跟排班那边一致。
export function timezone() {
  const s = readJSON(file('state.json'), null);
  return (s && s.settings && s.settings.timezone) || 'Australia/Melbourne';
}
export function todayStr(tz = timezone()) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}
export function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

export function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
