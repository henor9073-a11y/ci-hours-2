import { file, readJSON, writeJSON, now } from './common.js';
import { score } from './search.js';

// 便签本（notebook）同步 —— 辞 2026-09-27 定的方案 A。
//
// 辞的入口不变：她还是用 notebook 自己的 MCP 工具读写。木纹这边**单向**每 10 分钟拉一份过来，
// 只为了让召回能一起搜到。**永远不回写 notebook**，那是她的本子，不是木纹的存储。
//
// 存成独立的一张表，不混进纹理：纹理是从年轮提炼出来的记忆，这些是她自己随手写的便签，
// 两者的可信度、时效性、语气都不一样，混在一起会把召回带偏。
const FILE = file('notebook_notes.json');

// 地址带 token，所以只走环境变量，不写进仓库。没配就整个功能静默关闭。
const NOTEBOOK_URL = process.env.MUWEN_NOTEBOOK_URL || '';
// sticky 是长期铁律、today 是当下，这两个优先级最高（辞定的）；for_nor 是她写给棋子的。
// heartbeat/draft/games/past 不同步：心跳是机器写的，past 太大，draft/games 是草稿。
const SECTIONS = (process.env.MUWEN_NOTEBOOK_SECTIONS || 'sticky,today,for_nor').split(',').map(s => s.trim()).filter(Boolean);
export const PRIORITY_SECTIONS = new Set(['sticky', 'today']);

// 密码类的便签：存下来（辞自己搜得到），但**绝不自动注入**。
// 自动召回是把内容打进上下文的，那等于每次聊天都把密码摊开一次。
const SECRET_RE = /密码|password|passwd|口令|密钥|secret|token|api[\s_-]?key|验证码|私钥|助记词|账号密码|登录凭据/i;
export function looksSecret(text, tags = []) {
  return SECRET_RE.test(String(text || '')) || (tags || []).some(t => SECRET_RE.test(String(t)));
}

export function enabled() { return !!NOTEBOOK_URL; }

function load() {
  const d = readJSON(FILE, null);
  if (d && Array.isArray(d.notes)) return d;
  return { notes: [], synced_at: '', last_error: '' };
}

async function callNotebook(name, args, timeoutMs) {
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(NOTEBOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      signal: ctl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || 'notebook 报错');
    const text = j.result?.content?.[0]?.text ?? '';
    if (j.result?.isError) throw new Error(text.slice(0, 120));
    return JSON.parse(text);
  } finally {
    clearTimeout(kill);
  }
}

// 拉一遍。整份替换：notebook 那边删掉的、改过的，这边跟着走（单向镜像）。
export async function syncNotebook({ timeoutMs = 20000 } = {}) {
  if (!NOTEBOOK_URL) return { skipped: '没配 MUWEN_NOTEBOOK_URL' };
  const before = load();
  const prevById = Object.fromEntries(before.notes.map(n => [`${n.section}:${n.id}`, n]));
  const notes = [];
  const perSection = {};
  for (const section of SECTIONS) {
    const list = await callNotebook('note_read', { section }, timeoutMs);
    if (!Array.isArray(list)) continue;
    perSection[section] = list.length;
    for (const n of list) {
      const text = String(n.text || '').trim();
      if (!text) continue;
      const key = `${section}:${n.id}`;
      const prev = prevById[key];
      const changed = !prev || prev.text !== text;
      notes.push({
        id: key, note_id: n.id, section, text,
        tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
        at: n.at || '', edited_at: n.editedAt || '',
        secret: looksSecret(text, n.tags),
        priority: PRIORITY_SECTIONS.has(section),
        first_seen: prev?.first_seen || now(),
        changed_at: changed ? now() : prev.changed_at
      });
    }
  }
  const removed = before.notes.filter(n => !notes.some(x => x.id === n.id)).length;
  const added = notes.filter(n => !prevById[n.id]).length;
  const d = { notes, synced_at: now(), last_error: '', sections: perSection };
  writeJSON(FILE, d);
  return { total: notes.length, added, removed, sections: perSection, secret: notes.filter(n => n.secret).length, synced_at: d.synced_at };
}

export function noteStats() {
  const d = load();
  return { enabled: enabled(), total: d.notes.length, synced_at: d.synced_at || null,
    sections: d.sections || {}, secret: d.notes.filter(n => n.secret).length, last_error: d.last_error || undefined };
}

// 搜便签。includeSecret 只给"辞自己主动搜"的路径用，自动召回永远拿不到密码类。
export function searchNotes(query, { limit = 5, includeSecret = false, minScore = 4 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const hits = [];
  for (const n of load().notes) {
    if (n.secret && !includeSecret) continue;
    const s = score(q, n.text + ' ' + (n.tags || []).join(' '));
    if (s < minScore) continue;
    // sticky / today 是"当下最重要的"，同分优先，分也给一点加成
    hits.push({ ...n, score: s, _rank: s + (n.priority ? 8 : 0) });
  }
  hits.sort((a, b) => b._rank - a._rank);
  return hits.slice(0, limit);
}
