import { file, readJSON, writeJSON, newId, now, isDate } from './common.js';
import { searchGrains } from './grains.js';

// "我们的第一次们"。自动从纹理里筛"第一次…"，加上手动补的和置顶的。
// 自动筛的会随记忆增长自己变多；手动那份存在这里，不受影响。
const FILE = file('firsts.json');
const PATTERNS = [/第一次/, /头一次/, /第一天/, /首次/];

function load() {
  const d = readJSON(FILE, null);
  return d && typeof d === 'object' ? { manual: d.manual || [], pinned: d.pinned || [], hidden: d.hidden || [] } : { manual: [], pinned: [], hidden: [] };
}
function save(d) { writeJSON(FILE, d); }

// 从一条记忆里把"第一次…"那句话摘出来当标题
function titleOf(text) {
  const t = String(text).replace(/\s+/g, ' ');
  for (const p of PATTERNS) {
    const i = t.search(p);
    if (i === -1) continue;
    const seg = t.slice(i, i + 60);
    const cut = seg.search(/[。！？!?；;]/);
    return (cut > 4 ? seg.slice(0, cut) : seg).trim();
  }
  return t.slice(0, 40);
}

export function getFirsts({ limit = 200 } = {}) {
  const d = load();
  const hidden = new Set(d.hidden);
  const pinned = new Set(d.pinned);
  const auto = [];
  try {
    for (const g of searchGrains({ limit: 400, touchHits: false })) {
      if (hidden.has(g.id)) continue;
      if (!PATTERNS.some(p => p.test(g.text))) continue;
      auto.push({
        source: 'auto', id: g.id, title: titleOf(g.text), date: g.date || '',
        category: g.category, text: g.text, heat: Math.round(g.heat), pinned: pinned.has(g.id)
      });
    }
  } catch { /* 纹理读不到就只给手动的 */ }
  const manual = d.manual.filter(m => !hidden.has(m.id)).map(m => ({ source: 'manual', ...m, pinned: pinned.has(m.id) }));
  const all = [...manual, ...auto];
  // 置顶的在前，其余按日期倒序（没日期的排最后）
  all.sort((a, b) => (b.pinned - a.pinned) || String(b.date || '').localeCompare(String(a.date || '')));
  return { total: all.length, auto: auto.length, manual: manual.length, items: all.slice(0, limit) };
}

export function addFirst({ title, date = '', text = '', photo_id = '' }) {
  if (!title || !String(title).trim()) throw new Error('title 不能为空');
  if (date && !isDate(date)) throw new Error('date 要是 YYYY-MM-DD');
  const d = load();
  const item = { id: newId('f'), title: String(title).trim(), date, text: String(text || ''), photo_id: String(photo_id || ''), at: now() };
  d.manual.push(item); save(d);
  return item;
}
export function pinFirst(id, on = true) {
  const d = load();
  d.pinned = d.pinned.filter(x => x !== id);
  if (on) d.pinned.push(id);
  save(d);
  return { id, pinned: !!on };
}
export function hideFirst(id, on = true) {
  const d = load();
  d.hidden = d.hidden.filter(x => x !== id);
  if (on) d.hidden.push(id);
  save(d);
  return { id, hidden: !!on };
}
