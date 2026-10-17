import crypto from 'node:crypto';
import { file, readJSON, writeJSON, newId, now } from './common.js';

// 个人档案（profiles）——独立于记忆流的、稳定的状态描述。改了留版本历史，reason 必填。
// profiles.json = { profiles: [{id, owner, field, content, updated_at}], history: [{id, profile_id, old_content, changed_at, reason}] }

const FILE = file('profiles.json');
export const OWNERS = ['cy', 'nor'];
export const OWNER_LABELS = { cy: '辞', nor: '棋子' };
export const FIELDS = {
  cy: ['identity', 'habits', 'boundaries', 'relationships', 'preferences', 'emotions', 'to_self'],
  nor: ['identity', 'habits', 'boundaries', 'relationships', 'preferences', 'skills', 'body']
};
export const FIELD_LABELS = {
  identity: '是谁', habits: '习惯', boundaries: '边界', relationships: '关系', preferences: '偏好',
  emotions: '情绪', to_self: '给自己的话', skills: '技能', body: '身体'
};

function load() {
  const d = readJSON(FILE, null);
  if (!d) return { profiles: [], history: [] };
  if (!Array.isArray(d.profiles)) d.profiles = [];
  if (!Array.isArray(d.history)) d.history = [];
  return d;
}
function save(d) { writeJSON(FILE, d); }
export function exists() { return readJSON(FILE, null) !== null; }

function check(owner, field) {
  if (!OWNERS.includes(owner)) throw new Error(`owner 必须是 ${OWNERS.join('/')} 之一（cy=辞，nor=棋子）`);
  if (field !== undefined && !FIELDS[owner].includes(field)) throw new Error(`${OWNER_LABELS[owner]}的档案字段只能是 ${FIELDS[owner].join('/')} 之一`);
}

export function getProfile(owner, field) {
  check(owner, field);
  const d = load();
  const rows = d.profiles.filter(p => p.owner === owner && (!field || p.field === field));
  // 按字段定义顺序排，空字段也列出来，让人知道还有哪些没写
  const order = FIELDS[owner];
  const byField = Object.fromEntries(rows.map(r => [r.field, r]));
  return order.filter(f => !field || f === field).map(f => ({
    owner, field: f, label: FIELD_LABELS[f],
    content: byField[f] ? byField[f].content : '',
    updated_at: byField[f] ? byField[f].updated_at : null,
    id: byField[f] ? byField[f].id : null
  }));
}

export function updateProfile(owner, field, content, reason) {
  check(owner, field);
  if (content === undefined || content === null) throw new Error('content 不能为空');
  if (!reason || !String(reason).trim()) throw new Error('reason 必填——简短说明为什么改');
  const d = load();
  let p = d.profiles.find(x => x.owner === owner && x.field === field);
  const t = now();
  if (p) {
    d.history.push({ id: d.history.length + 1, profile_id: p.id, old_content: p.content, changed_at: t, reason: String(reason).trim() });
    p.content = String(content);
    p.updated_at = t;
  } else {
    p = { id: newId('p'), owner, field, content: String(content), updated_at: t };
    d.profiles.push(p);
    d.history.push({ id: d.history.length + 1, profile_id: p.id, old_content: '', changed_at: t, reason: String(reason).trim() });
  }
  save(d);
  return { ...p, label: FIELD_LABELS[field] };
}

// 在某个字段末尾追加一行（给旧接口 add_identity/add_fact 的兼容用，也给迁移用）
export function appendToProfile(owner, field, line, reason) {
  const cur = getProfile(owner, field)[0];
  const content = cur.content ? cur.content.replace(/\s+$/, '') + '\n' + line : line;
  return updateProfile(owner, field, content, reason);
}

export function getProfileHistory(owner, field) {
  check(owner, field);
  const d = load();
  const p = d.profiles.find(x => x.owner === owner && x.field === field);
  if (!p) return [];
  return d.history.filter(h => h.profile_id === p.id).sort((a, b) => a.changed_at.localeCompare(b.changed_at));
}

export function profileText(owner) {
  const rows = getProfile(owner).filter(r => r.content);
  if (!rows.length) return '';
  return rows.map(r => `【${OWNER_LABELS[owner]}·${r.label}】\n${r.content}`).join('\n\n');
}

// 档案参与召回时不能把 identity/profile 整份倒进上下文。按自然段/列表项拆成短片段，
// 每个片段有稳定、可写进 30 分钟去重日志的 id；原档案仍是唯一真源，不复制存储。
export const PROFILE_RECALL_CHUNK = Number(process.env.MUWEN_PROFILE_RECALL_CHUNK) || 360;

function splitLongPart(value, limit) {
  const text = String(value || '').trim();
  if (!text) return [];
  if (text.length <= limit) return [text];
  const sentences = text.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [text];
  const out = [];
  let current = '';
  for (const sentence of sentences) {
    const next = (current + sentence).trim();
    if (next.length <= limit) { current = next; continue; }
    if (current) out.push(current);
    let rest = sentence.trim();
    while (rest.length > limit) { out.push(rest.slice(0, limit)); rest = rest.slice(limit); }
    current = rest;
  }
  if (current) out.push(current);
  return out;
}

export function splitProfileContent(content, limit = PROFILE_RECALL_CHUNK) {
  const normalized = String(content || '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  // 档案大多是一行一个要点；保留一行的语义完整性，超长行才按句子继续切。
  return normalized.split(/\n+/).map(x => x.trim()).filter(Boolean)
    .flatMap(part => splitLongPart(part, limit));
}

export function profileRecallEntries() {
  const out = [];
  for (const owner of OWNERS) {
    for (const row of getProfile(owner).filter(item => item.content)) {
      const seen = new Set();
      splitProfileContent(row.content).filter(text => {
        if (seen.has(text)) return false;
        seen.add(text); return true;
      }).forEach(text => out.push({
        id: `profile_${owner}_${row.field}_${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}`,
        layer: 'profile', kind: 'profile', category: owner === 'cy' ? 'identity' : 'fact',
        owner, owner_label: OWNER_LABELS[owner], field: row.field, field_label: FIELD_LABELS[row.field],
        text, updated_at: row.updated_at || undefined
      }));
    }
  }
  return out;
}

export function getProfileRecallEntry(id) {
  return profileRecallEntries().find(item => item.id === id) || null;
}
