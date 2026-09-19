import { file, readJSON, writeJSON, newId, now, todayStr, isDate } from './common.js';

// 人际关系（social）+ 八卦（gossip）。
// 人卡按 name 唯一：同一个人再 remember 一次是更新，不是新建——关系状态会变（正常→吵架中→和好）。
// 状态改了会把旧状态留在 status_history 里，回头能看出"之前吵过"。
// 八卦挂在人名上（about），召回的时候提到这个人，卡片 + 最近几条八卦一起带出来。
const FILE = file('social.json');
export const OWNERS = ['nor', 'cy', 'shared'];
const OWNER_ALIASES = { '棋子': 'nor', '辞': 'cy', '共同': 'shared', '共同好友': 'shared', '两个人': 'shared' };
const FIELDS = ['gender', 'relation', 'owner', 'intro', 'status', 'text'];

function load() {
  const d = readJSON(FILE, null) || {};
  return { people: Array.isArray(d.people) ? d.people : [], gossip: Array.isArray(d.gossip) ? d.gossip : [] };
}
function save(d) { writeJSON(FILE, d); }

const key = s => String(s || '').trim().toLowerCase();
function normOwner(o) {
  if (o === undefined || o === null || o === '') return undefined;
  const v = OWNER_ALIASES[String(o).trim()] || key(o);
  if (!OWNERS.includes(v)) throw new Error(`owner 只能是 ${OWNERS.join('/')}`);
  return v;
}
function normAliases(a) {
  if (a === undefined || a === null || a === '') return undefined;
  const arr = Array.isArray(a) ? a : String(a).split(/[,，、]+/);
  return [...new Set(arr.map(x => String(x).trim()).filter(Boolean))];
}
function namesOf(p) { return [p.name, ...(p.aliases || [])]; }
function findIn(d, name) {
  const k = key(name);
  return d.people.find(p => namesOf(p).some(n => key(n) === k)) || null;
}
function gossipFor(d, p, limit) {
  const names = new Set(namesOf(p).map(key));
  return d.gossip.filter(g => g.about.some(a => names.has(key(a))))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, limit);
}

// 新建或更新。只改传了的字段，没传的保留原样；想清空一个字段传空字符串以外的东西不行，
// 这是故意的——remember 覆盖的时候经常只带一两个字段，不能把别的冲掉。
export function upsertPerson(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('name 是必填的');
  const d = load();
  const patch = {};
  for (const f of FIELDS) if (input[f] !== undefined && input[f] !== null && input[f] !== '') patch[f] = String(input[f]).trim();
  if (patch.owner) patch.owner = normOwner(patch.owner);
  const aliases = normAliases(input.aliases);
  let p = findIn(d, name);
  const created = !p;
  if (!p) {
    p = { id: newId('pp'), name, gender: '', relation: '', owner: 'nor', intro: '', status: '', text: '', aliases: [], status_history: [], created_at: now(), updated_at: now() };
    d.people.push(p);
  }
  if (patch.status && p.status && patch.status !== p.status) {
    p.status_history = [...(p.status_history || []), { status: p.status, until: now() }];
  }
  Object.assign(p, patch);
  if (aliases) p.aliases = [...new Set([...(p.aliases || []), ...aliases])].filter(a => key(a) !== key(p.name));
  // 用别名找到的人，传进来的 name 也记成别名，下次两个叫法都认
  if (!created && key(name) !== key(p.name) && !(p.aliases || []).some(a => key(a) === key(name))) p.aliases = [...(p.aliases || []), name];
  if (input.rename && String(input.rename).trim()) {
    const nn = String(input.rename).trim();
    const other = findIn(d, nn);
    if (other && other !== p) throw new Error(`已经有一个叫「${nn}」的人了`);
    p.aliases = [...new Set([...(p.aliases || []), p.name])].filter(a => key(a) !== key(nn));
    p.name = nn;
  }
  p.updated_at = now();
  save(d);
  return { ...p, created, gossip_count: gossipFor(d, p, 1e9).length };
}

export function getPerson(name, { gossipLimit = 20 } = {}) {
  const d = load();
  const p = findIn(d, name);
  return p ? { ...p, gossip: gossipFor(d, p, gossipLimit) } : null;
}

export function listPeople({ owner } = {}) {
  const d = load();
  const o = normOwner(owner);
  return d.people.filter(p => !o || p.owner === o)
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .map(p => ({ ...p, gossip_count: gossipFor(d, p, 1e9).length }));
}

export function addGossip({ about, text, date } = {}) {
  if (!text || !String(text).trim()) throw new Error('text 是必填的');
  const d = load();
  const names = (normAliases(about) || []);
  if (date && !isDate(date)) throw new Error('date 要是 YYYY-MM-DD');
  // about 写的是别名也行，存的时候统一成人卡上的正式名字
  const resolved = names.map(n => { const p = findIn(d, n); return p ? p.name : n; });
  const g = { id: newId('gs'), about: resolved, text: String(text).trim(), date: date || todayStr(), created_at: now() };
  d.gossip.push(g);
  save(d);
  const unknown = resolved.filter(n => !findIn(d, n));
  return { ...g, ...(unknown.length ? { note: `social 里还没有「${unknown.join('、')}」的卡片，八卦先存着；用 remember("social", name=…) 建一张，以后提到就会一起召回。` } : {}) };
}

export function getGossip({ about, limit = 50 } = {}) {
  const d = load();
  if (about) {
    const p = findIn(d, about);
    if (p) return gossipFor(d, p, limit);
    const k = key(about);
    return d.gossip.filter(g => g.about.some(a => key(a) === k)).slice(-limit).reverse();
  }
  return d.gossip.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, limit);
}

// 召回用：这句话里提到了谁。只认人卡上的名字和别名（还有只有八卦、没建卡的名字）。
// 单个字的名字太容易误中（"A""姐"），至少两个字才算，除非是纯英文/数字的完整词。
export function mentionedPeople(text, { gossipLimit = 3 } = {}) {
  const t = key(text);
  if (!t) return [];
  const d = load();
  const hit = (n) => {
    const k = key(n);
    if (!k) return false;
    if (/^[a-z0-9]+$/.test(k)) return new RegExp(`(^|[^a-z0-9])${k}($|[^a-z0-9])`).test(t);
    return k.length >= 2 && t.includes(k);
  };
  const out = [];
  for (const p of d.people) {
    const matched = namesOf(p).find(hit);
    if (matched) out.push({ person: p, matched, gossip: gossipFor(d, p, gossipLimit) });
  }
  // 只有八卦没有卡片的名字也带出来
  const known = new Set(d.people.flatMap(p => namesOf(p).map(key)));
  const orphan = {};
  for (const g of d.gossip) for (const a of g.about) if (!known.has(key(a)) && hit(a)) (orphan[a] = orphan[a] || []).push(g);
  for (const [name, gs] of Object.entries(orphan)) {
    out.push({ person: null, matched: name, gossip: gs.sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, gossipLimit) });
  }
  // 长名字先（"小A姐姐"和"小A"同时命中时前者更具体）
  return out.sort((a, b) => b.matched.length - a.matched.length);
}

const OWNER_CN = { nor: '棋子的人', cy: '辞的人', shared: '共同的' };
export function formatPerson(p) {
  const bits = [p.gender, p.relation || OWNER_CN[p.owner], p.status ? `状态：${p.status}` : ''].filter(Boolean).join(' · ');
  return `${p.name}${p.aliases && p.aliases.length ? `（也叫${p.aliases.join('、')}）` : ''}｜${bits}${p.intro ? `｜${p.intro}` : ''}${p.text ? `｜备注：${p.text}` : ''}`;
}
