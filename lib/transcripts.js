import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';
const TRANSCRIPTS_FILE = path.join(DATA_DIR, 'transcripts.json');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function newId() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function now() { return new Date().toISOString(); }

// 原始记录单独存一个文件，不跟五类摘要挤在 memory.json 里——这里可能会存进
// 整段导出的聊天记录，体积跟别的记忆条目完全不是一个量级，分开管更干净。
// 第一次跑的时候，如果 transcripts.json 还不存在但 memory.json 里有旧数据，
// 自动把旧数据迁过来，不需要手动搬。
function ensureFile() {
  if (fs.existsSync(TRANSCRIPTS_FILE)) return;
  const mem = readJSON(MEMORY_FILE, null);
  if (mem && Array.isArray(mem.transcripts) && mem.transcripts.length) {
    writeJSON(TRANSCRIPTS_FILE, mem.transcripts.map(x => ({ title: '', category: 'raw', ...x })));
  } else {
    writeJSON(TRANSCRIPTS_FILE, []);
  }
}
ensureFile();

// category 区分"原始聊天记录"(raw，默认，逐字摘录不要总结) 和
// "每日总结"(daily_summary，浓缩过的当天进展描述)——两者存在同一个文件里，
// 用这个字段分开看，不是两套存储。旧数据没有这个字段，读的时候当成 'raw' 处理。
const VALID_CATEGORIES = ['raw', 'daily_summary'];
function normalizeCategory(c) {
  return VALID_CATEGORIES.includes(c) ? c : 'raw';
}

export function addTranscript(text, relatedTo = [], date = '', title = '', category = 'raw') {
  const list = readJSON(TRANSCRIPTS_FILE, []);
  const entry = {
    id: newId(),
    text,
    title,
    category: normalizeCategory(category),
    relatedTo: Array.isArray(relatedTo) ? relatedTo : [],
    date,
    addedAt: now()
  };
  list.push(entry);
  writeJSON(TRANSCRIPTS_FILE, list);
  return entry;
}

// 每日总结的专用入口——本质就是 category 固定成 daily_summary 的 addTranscript，
// 单独导出一个函数是为了让调用方（mcp.js 里的 add_daily_summary 工具）不用
// 每次都记得传 category 这个参数，也让意图更清楚。
export function addDailySummary(text, date = '', title = '') {
  return addTranscript(text, [], date, title, 'daily_summary');
}

// 批量导入用——比如棋子把 claude.ai 导出的原始对话一次性发过来的时候，
// 一次调用存多条，不用一条条调工具。批量导入目前只用于原始记录，category 固定 raw。
export function importTranscriptsBulk(entries) {
  const list = readJSON(TRANSCRIPTS_FILE, []);
  const added = [];
  for (const e of (entries || [])) {
    if (!e || !e.text) continue;
    const entry = {
      id: newId(),
      text: e.text,
      title: e.title || '',
      category: 'raw',
      relatedTo: Array.isArray(e.relatedTo) ? e.relatedTo : [],
      date: e.date || '',
      addedAt: now()
    };
    list.push(entry);
    added.push(entry);
  }
  writeJSON(TRANSCRIPTS_FILE, list);
  return added;
}

// 删一条记录——比如导入时手误存了占位文字、存重复了、或者要把一条原始记录
// "移动"到每日总结（做法是：先 addDailySummary 存一条新的，确认没问题后
// 再用这个把旧的原始记录删掉，不是原地改 category，保留操作是两步更安全）。
// 真删除，不是归档——原始聊天记录体积大，不值得像五类记忆那样留痕迹。
export function removeTranscript(id) {
  const list = readJSON(TRANSCRIPTS_FILE, []);
  const idx = list.findIndex(x => x.id === id);
  if (idx === -1) return null;
  const [removed] = list.splice(idx, 1);
  writeJSON(TRANSCRIPTS_FILE, list);
  return removed;
}

// 列表/搜索这两个接口现在只返回摘要（标题、日期、字数、一小段摘录），不是整段原文——
// 有些导入的对话原文很长（一条几万字很常见），如果每次列表/搜索都把全文倒出来，
// 页面会卡、MCP 工具调用也会因为单次返回太大直接报错。真要看全文用 getTranscriptById。
function excerpt(text, keyword, radius = 150) {
  const t = text || '';
  if (keyword) {
    const idx = t.toLowerCase().indexOf(keyword.toLowerCase());
    if (idx !== -1) {
      const start = Math.max(0, idx - radius);
      const end = Math.min(t.length, idx + keyword.length + radius);
      return (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '');
    }
  }
  return t.length > 300 ? t.slice(0, 300) + '…' : t;
}
function toSummary(x, keyword = '') {
  return {
    id: x.id,
    title: x.title || '',
    category: normalizeCategory(x.category),
    date: x.date || '',
    addedAt: x.addedAt,
    length: (x.text || '').length,
    excerpt: excerpt(x.text, keyword)
  };
}

// category 传了就只看那一类（'raw' 或 'daily_summary'），不传就是全部，
// 跟以前的行为保持一致，不会因为加了分类就影响旧的调用方式。
export function getTranscripts(limit = 10, category = '') {
  let list = readJSON(TRANSCRIPTS_FILE, []);
  if (category) list = list.filter(x => normalizeCategory(x.category) === category);
  return list.slice(-limit).reverse().map(x => toSummary(x));
}

// 关键词搜索——标题和正文都搜，大小写不敏感。棋子和辞都能用这个找以前的原话，
// 不用再翻"最近几条"翻不到。同样支持可选的 category 过滤。
export function searchTranscripts(keyword, limit = 20, category = '') {
  const kw = (keyword || '').trim().toLowerCase();
  if (!kw) return [];
  let list = readJSON(TRANSCRIPTS_FILE, []);
  if (category) list = list.filter(x => normalizeCategory(x.category) === category);
  const matches = list.filter(x =>
    (x.text || '').toLowerCase().includes(kw) || (x.title || '').toLowerCase().includes(kw)
  );
  return matches.slice(-limit).reverse().map(x => toSummary(x, kw));
}

// 拿某一条的完整原文——列表/搜索里没有全文，需要看全文的时候单独调这个。
export function getTranscriptById(id) {
  const list = readJSON(TRANSCRIPTS_FILE, []);
  return list.find(x => x.id === id) || null;
}

// 给网页"每日记录"日历用的——按月拿这个月有哪些每日总结，只给列表用的精简字段
// （id/date/title），不带正文，正文还是用 getTranscriptById 单独拿。
export function getDailySummariesByMonth(month) {
  const list = readJSON(TRANSCRIPTS_FILE, []);
  return list
    .filter(x => normalizeCategory(x.category) === 'daily_summary' && (x.date || '').startsWith(month))
    .map(x => ({ id: x.id, date: x.date, title: x.title || '' }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
