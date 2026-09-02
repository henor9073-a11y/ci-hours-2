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
