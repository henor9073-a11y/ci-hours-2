import { file, readJSON, writeJSON, newId, now, todayStr } from './common.js';

// 倒数日。date 是 MM-DD（每年重复）或 YYYY-MM-DD（一次性）。
const FILE = file('countdowns.json');

// 设计文档第六节里的初始倒数日，只在文件还不存在的时候种一次。
const SEED = [
  { id: 'cd1', title: '生日/第一次说话', date: '07-21', recurring: true },
  { id: 'cd2', title: '棋子生日', date: '02-19', recurring: true },
  { id: 'cd3', title: '恋爱纪念日', date: '08-02', recurring: true },
  { id: 'cd4', title: '求婚日', date: '08-18', recurring: true },
  { id: 'cd5', title: '结婚纪念日', date: '08-21', recurring: true }
];

function load() {
  const d = readJSON(FILE, null);
  if (d) return d;
  const seeded = SEED.map(x => ({ ...x, created_at: now() }));
  writeJSON(FILE, seeded);
  return seeded;
}
function save(list) { writeJSON(FILE, list); }

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

export function addCountdown(title, date, recurring) {
  if (!title || !String(title).trim()) throw new Error('title 不能为空');
  const isMMDD = /^\d{2}-\d{2}$/.test(date || '');
  const isFull = /^\d{4}-\d{2}-\d{2}$/.test(date || '');
  if (!isMMDD && !isFull) throw new Error('date 要是 MM-DD（每年重复）或 YYYY-MM-DD（一次性）');
  const rec = recurring === undefined ? isMMDD : !!recurring;
  if (rec && isFull) date = date.slice(5);        // 每年重复的只留月日
  if (!rec && isMMDD) throw new Error('一次性的倒数日要给完整日期 YYYY-MM-DD');
  const list = load();
  const entry = { id: newId('cd'), title: String(title).trim(), date, recurring: rec, created_at: now() };
  list.push(entry);
  save(list);
  return entry;
}

export function removeCountdown(id) {
  const list = load();
  const idx = list.findIndex(x => x.id === id);
  if (idx === -1) return null;
  const [removed] = list.splice(idx, 1);
  save(list);
  return removed;
}

export function getCountdowns(limit) {
  const today = todayStr();
  const year = parseInt(today.slice(0, 4), 10);
  const out = load().map(c => {
    let next;
    if (c.recurring) {
      next = `${year}-${c.date}`;
      if (next < today) next = `${year + 1}-${c.date}`;
    } else next = c.date;
    const days = daysBetween(today, next);
    return { ...c, next_date: next, days_until: days, is_today: days === 0, passed: !c.recurring && days < 0 };
  }).sort((a, b) => {
    // 最近的排前面；已经过去的一次性日期排最后
    const ka = a.days_until < 0 ? 100000 + a.days_until : a.days_until;
    const kb = b.days_until < 0 ? 100000 + b.days_until : b.days_until;
    return ka - kb;
  });
  return limit ? out.slice(0, limit) : out;
}
