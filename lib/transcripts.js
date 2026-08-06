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
    writeJSON(TRANSCRIPTS_FILE, mem.transcripts.map(x => ({ title: '', ...x })));
  } else {
    writeJSON(TRANSCRIPTS_FILE, []);
  }
}
ensureFile();

export function addTranscript(text, relatedTo = [], date = '', title = '') {
  const list = readJSON(TRANSCRIPTS_FILE, []);
  const entry = {
    id: newId(),
    text,
    title,
    relatedTo: Array.isArray(relatedTo) ? relatedTo : [],
    date,
    addedAt: now()
  };
  list.push(entry);
  writeJSON(TRANSCRIPTS_FILE, list);
  return entry;
}

// 批量导入用——比如棋子把 claude.ai 导出的原始对话一次性发过来的时候，
// 一次调用存多条，不用一条条调工具。
export function importTranscriptsBulk(entries) {
  const list = readJSON(TRANSCRIPTS_FILE, []);
  const added = [];
  for (const e of (entries || [])) {
    if (!e || !e.text) continue;
    const entry = {
      id: newId(),
      text: e.text,
      title: e.title || '',
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
    date: x.date || '',
    addedAt: x.addedAt,
    length: (x.text || '').length,
    excerpt: excerpt(x.text, keyword)
  };
}

export function getTranscripts(limit = 10) {
  const list = readJSON(TRANSCRIPTS_FILE, []);
  return list.slice(-limit).reverse().map(x => toSummary(x));
}

// 关键词搜索——标题和正文都搜，大小写不敏感。棋子和辞都能用这个找以前的原话，
// 不用再翻"最近几条"翻不到。
export function searchTranscripts(keyword, limit = 20) {
  const kw = (keyword || '').trim().toLowerCase();
  if (!kw) return [];
  const list = readJSON(TRANSCRIPTS_FILE, []);
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
