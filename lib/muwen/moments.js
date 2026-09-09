import { file, readJSON, writeJSON, now, todayStr, isDate } from './common.js';

// 个人今日动态（头像点进去那一页）。
// 故意跟每日总结分开存：每日总结是早上 8 点自动跑的叙事记录，同一天再写一次是整体覆盖——
// 手动填的 OOTD / 今天做了什么如果塞在那里面，会被自动总结冲掉。这里各存各的，互不打架。
// 两个人的动态双方都能编辑（谁改的记在 updated_by 里）。

const FILE = file('moments.json');
export const OWNERS = ['cy', 'nor'];
export const OWNER_LABELS = { cy: '辞', nor: '棋子' };
// cy 只有"今天做了什么"；nor 多 OOTD（手机使用是 Supabase 那边读的，不在这里存）
export const FIELDS = {
  cy: ['did', 'note'],
  nor: ['did', 'ootd', 'ootd_photo', 'note']
};

function load() { const d = readJSON(FILE, null); return d && typeof d === 'object' ? d : {}; }
function save(d) { writeJSON(FILE, d); }

function blank(owner) {
  const o = {};
  for (const f of FIELDS[owner]) o[f] = '';
  return { ...o, updated_at: null, updated_by: null };
}

export function getMoment(date) {
  const d = isDate(date) ? date : todayStr();
  const all = load();
  const day = all[d] || {};
  return { date: d, cy: { ...blank('cy'), ...(day.cy || {}) }, nor: { ...blank('nor'), ...(day.nor || {}) } };
}

export function setMoment(date, owner, fields = {}, by = '') {
  const d = isDate(date) ? date : todayStr();
  if (!OWNERS.includes(owner)) throw new Error(`owner 必须是 ${OWNERS.join('/')} 之一`);
  const allowed = FIELDS[owner];
  const patch = {};
  for (const k of Object.keys(fields)) {
    if (!allowed.includes(k)) throw new Error(`${OWNER_LABELS[owner]}的动态只有 ${allowed.join('/')} 这几个字段`);
    patch[k] = String(fields[k] == null ? '' : fields[k]);
  }
  if (!Object.keys(patch).length) throw new Error('至少要给一个字段');
  const all = load();
  const day = all[d] || {};
  day[owner] = { ...blank(owner), ...(day[owner] || {}), ...patch, updated_at: now(), updated_by: by || '' };
  all[d] = day;
  save(all);
  return { date: d, owner, ...day[owner] };
}

// 最近几天有动态的日子，给"翻看以前"用
export function recentMoments(limit = 14) {
  const all = load();
  return Object.keys(all).sort().reverse().slice(0, limit).map(d => ({ date: d, ...getMoment(d) }));
}
