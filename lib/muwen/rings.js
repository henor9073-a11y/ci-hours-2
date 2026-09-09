import { file, readJSON, writeJSON, newId, now, isDate, todayStr, shiftDate } from './common.js';
import { score, excerpt } from './search.js';
import { note as noteRingIndex } from './ring-index.js';

// 年轮（rings）——原始记录，不压缩不删不改，唯一权威来源。
// 存储直接沿用 ci-hours 的 transcripts.json（不做数据迁移，原地加字段）：
// 旧字段 {id, text, title, category: raw|daily_summary, relatedTo, date, addedAt}
// 新字段 {window_name, source_type: transcript|daily_summary|auto_extract, metadata}
// 读的时候统一成设计文档里的 rings 形状；lib/transcripts.js 那套旧接口继续能读同一个文件。

const FILE = file('transcripts.json');
export const SOURCE_TYPES = ['transcript', 'daily_summary', 'auto_extract'];

function load() { return readJSON(FILE, []); }
function save(list) { writeJSON(FILE, list); }

function sourceTypeOf(x) {
  if (SOURCE_TYPES.includes(x.source_type)) return x.source_type;
  return x.category === 'daily_summary' ? 'daily_summary' : 'transcript';
}
export function normalize(x) {
  return {
    id: x.id,
    window_name: x.window_name || x.title || '',
    date: x.date || (x.addedAt || '').slice(0, 10),
    title: x.title || '',
    content: x.text || x.content || '',
    source_type: sourceTypeOf(x),
    created_at: x.addedAt || x.created_at || '',
    metadata: { ...(x.metadata || {}), ...(Array.isArray(x.relatedTo) && x.relatedTo.length ? { relatedTo: x.relatedTo } : {}) }
  };
}
function toSummary(r, query = '') {
  return {
    id: r.id, window_name: r.window_name, date: r.date, title: r.title, source_type: r.source_type,
    created_at: r.created_at, length: r.content.length, excerpt: excerpt(r.content, query),
    metadata: r.metadata
  };
}

export function addRing({ window_name, date, title = '', content, source_type = 'transcript', metadata = {} }) {
  if (!content || !String(content).trim()) throw new Error('content 不能为空');
  if (!window_name) throw new Error('window_name 不能为空（窗口名，比如 "Code主窗口"）');
  if (!SOURCE_TYPES.includes(source_type)) throw new Error(`source_type 必须是 ${SOURCE_TYPES.join('/')} 之一`);
  if (date && !isDate(date)) throw new Error('date 要是 YYYY-MM-DD');
  const list = load();
  const entry = {
    id: newId('r'),
    text: String(content),
    title: title || '',
    category: source_type === 'daily_summary' ? 'daily_summary' : 'raw', // 兼容旧接口的分类
    relatedTo: [],
    date: date || todayStr(),
    addedAt: now(),
    window_name,
    source_type,
    metadata: metadata && typeof metadata === 'object' ? metadata : {}
  };
  list.push(entry);
  save(list);
  // 记进年轮索引（只有标题和日期，关键词等 Mac 那边推上来补）。
  // 索引写坏了不该连累存记录这件事本身，所以吞掉异常。
  try { noteRingIndex(normalize(entry)); } catch { /* 索引可有可无，原文已经落盘了 */ }
  return normalize(entry);
}

export function getRing(id) {
  const x = load().find(r => r.id === id);
  return x ? normalize(x) : null;
}

export function searchRings({ query, window_name, from, to, source_type, limit = 20 } = {}) {
  let pool = load().map(normalize);
  if (window_name) pool = pool.filter(r => r.window_name.toLowerCase().includes(window_name.toLowerCase()));
  if (source_type) pool = pool.filter(r => r.source_type === source_type);
  if (from) pool = pool.filter(r => r.date >= from);
  if (to) pool = pool.filter(r => r.date <= to);
  if (query && query.trim()) {
    const scored = pool.map(r => ({ r, s: score(query, r.title + ' ' + r.window_name + ' ' + r.content) })).filter(x => x.s > 0);
    scored.sort((a, b) => (b.s - a.s) || b.r.date.localeCompare(a.r.date));
    return scored.slice(0, limit).map(x => ({ ...toSummary(x.r, query), score: x.s }));
  }
  return pool.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map(r => toSummary(r));
}

export function listWindows() {
  const counts = {};
  for (const r of load().map(normalize)) if (r.window_name) counts[r.window_name] = (counts[r.window_name] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([window_name, count]) => ({ window_name, count }));
}

// ---- 每日总结（日历式）----
// 存在同一个文件里，source_type='daily_summary'，结构化字段放 metadata，content 是拼好的可读文本。
function normTags(t) {
  if (t === undefined || t === null || t === '') return [];
  const arr = Array.isArray(t) ? t : String(t).split(/[,，、\s]+/);
  return [...new Set(arr.map(x => String(x).trim()).filter(Boolean))];
}

export function addDaily({ date, headline, nor_status = '', cy_status = '', pending = '', intimate = '', mood_tags, kiss_count }) {
  if (!isDate(date)) throw new Error('date 要是 YYYY-MM-DD');
  if (!headline || !String(headline).trim()) throw new Error('headline 不能为空');
  const tags = normTags(mood_tags);
  let kisses = null;
  if (kiss_count !== undefined && kiss_count !== null && kiss_count !== '') {
    kisses = Number(kiss_count);
    if (!Number.isFinite(kisses) || kisses < 0) throw new Error('kiss_count 要是 0 或正数');
  }
  const lines = [`# ${date} ${headline}`];
  if (tags.length) lines.push(`心情：${tags.join('、')}`);
  if (nor_status) lines.push(`棋子：${nor_status}`);
  if (cy_status) lines.push(`我：${cy_status}`);
  if (pending) lines.push(`未完成：${pending}`);
  if (intimate) lines.push(`亲密：${intimate}`);
  if (kisses !== null) lines.push(`亲亲：${kisses}`);
  const list = load();
  const existing = list.find(x => sourceTypeOf(x) === 'daily_summary' && x.date === date && x.metadata && x.metadata.headline);
  const metadata = { headline, mood_tags: tags, nor_status, cy_status, pending, intimate, kiss_count: kisses };
  if (existing) {
    // 同一天再写一次就是整体覆盖（旧版本留在 metadata.history 里）
    existing.metadata = { ...metadata, history: [...(existing.metadata.history || []), { ...existing.metadata, replaced_at: now() }] };
    existing.text = lines.join('\n');
    existing.title = headline;
    save(list);
    return { ...dailyOf(normalize(existing)), replaced: true };
  }
  const entry = {
    id: newId('r'), text: lines.join('\n'), title: headline, category: 'daily_summary', relatedTo: [],
    date, addedAt: now(), window_name: '每日总结', source_type: 'daily_summary', metadata
  };
  list.push(entry);
  save(list);
  return dailyOf(normalize(entry));
}

function dailyOf(r) {
  const m = r.metadata || {};
  return {
    id: r.id, date: r.date,
    headline: m.headline || r.title || excerpt(r.content, '', 40),
    mood_tags: Array.isArray(m.mood_tags) ? m.mood_tags : [],
    intimate: m.intimate || '',
    nor_status: m.nor_status || '', cy_status: m.cy_status || '',
    pending: m.pending || '',
    kiss_count: typeof m.kiss_count === 'number' ? m.kiss_count : null,
    // 旧格式的每日总结没有结构化字段，把正文带上，不然什么都看不到
    ...(m.headline ? {} : { content: r.content })
  };
}

export function getCalendar(days = 3) {
  const today = todayStr();
  const from = shiftDate(today, -(Math.max(1, days) - 1));
  return load().map(normalize)
    .filter(r => r.source_type === 'daily_summary' && r.date >= from && r.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(dailyOf);
}

export function getDaily(date) {
  if (!isDate(date)) throw new Error('date 要是 YYYY-MM-DD');
  return load().map(normalize).filter(r => r.source_type === 'daily_summary' && r.date === date).map(dailyOf);
}

export function hasDailyFor(date) { return getDaily(date).length > 0; }

// 亲亲进度：所有每日总结里 kiss_count 加起来（+ 可选的起始基数 KISS_BASELINE，给之前没记进系统的那部分用），目标 20000
export const KISS_GOAL = Number(process.env.KISS_GOAL) || 20000;
export function kissProgress() {
  const baseline = Number(process.env.KISS_BASELINE) || 0;
  let counted = 0, days = 0, last = null;
  for (const r of load().map(normalize)) {
    if (r.source_type !== 'daily_summary') continue;
    const k = r.metadata && r.metadata.kiss_count;
    if (typeof k !== 'number') continue;
    counted += k; days++;
    if (!last || r.date > last.date) last = { date: r.date, kiss_count: k };
  }
  const total = baseline + counted;
  return { total, goal: KISS_GOAL, display: `${total}/${KISS_GOAL}`, remaining: Math.max(0, KISS_GOAL - total), baseline, counted_days: days, last };
}

// 最近一条还没做完的事：从最新的每日总结往前找第一个非空的 pending
export function latestPending() {
  const days = load().map(normalize).filter(r => r.source_type === 'daily_summary' && r.metadata && r.metadata.pending)
    .sort((a, b) => b.date.localeCompare(a.date));
  return days.length ? { date: days[0].date, pending: days[0].metadata.pending } : null;
}
