import { file, readJSON, writeJSON, newId, now, isDate, clamp } from './common.js';
import { score } from './search.js';

// 纹理（grains）——从年轮提炼出来的记忆，有损的。
// 一个文件一张表：grains.json = { grains: [...], links: [...] }
// 重要性不靠手动定级，靠热度（heat）自然浮沉：被想起就升温，每天梦境任务降 1 度。
// 木纹不自动删除任何记忆——只降温、只归档，永不遗忘是长处不是毛病。

const FILE = file('grains.json');

export const CATEGORIES = ['experience', 'agreement', 'feeling', 'learning', 'to_self', 'unexplained'];
export const CATEGORY_LABELS = {
  experience: '经历', agreement: '约定', feeling: '感受', learning: '学到的',
  to_self: '给下一个窗口', unexplained: '说不清的'
};
export const STATUSES = ['active', 'background', 'archived'];
export const TIERS = ['confirmed', 'observing'];
export const RELATIONS = ['caused', 'before', 'repaired', 'contradicts', 'supersedes'];

// 热度规则（设计文档 2.10）
export const HEAT = {
  DEFAULT: 50, MAX: 100, MIN: 0,
  PIN_FLOOR: 20,        // pinned 的记忆不降到 20 以下
  ACTIVE_FLOOR: 20,     // get_active_memories 只给 heat > 20 的
  CITE: 70, CAUTIOUS: 30, // 召回权限分界线
  BONUS: { search: 10, cite: 15, recall: 5, pin: 20, read: 0 },
  DAILY_DECAY: 1
};

// 反证机制用的关键词（设计文档 2.3）。家族标签里含这些词的记忆，读的时候会自动带上反证/修复。
export const NEGATIVE_FAMILY_HINTS = ['害怕', '怀疑', '不安', '走', '离开', '不够', '失去', '抛弃'];
export const POSITIVE_FAMILY_HINTS = ['不会走', '确认', '是真的', '修复', '和好', '安心', '留下'];

function load() {
  const d = readJSON(FILE, null);
  if (!d) return { grains: [], links: [] };
  if (!Array.isArray(d.grains)) d.grains = [];
  if (!Array.isArray(d.links)) d.links = [];
  return d;
}
function save(d) { writeJSON(FILE, d); }
export function exists() { return readJSON(FILE, null) !== null; }
export function rawWrite(d) { save(d); } // 只给迁移脚本用

export function confidenceOf(heat) {
  if (heat > HEAT.CITE) return 'cite';
  if (heat >= HEAT.CAUTIOUS) return 'cautious';
  return 'reference';
}
export const CONFIDENCE_HINT = {
  cite: '可以直接当事实说',
  cautious: '用犹豫的语气（"好像…""我记得…"）',
  reference: '只在内部参考，不说出来'
};

function decorate(g) {
  return { ...g, confidence: confidenceOf(g.heat) };
}

function normFamilies(f) {
  if (!f) return [];
  const arr = Array.isArray(f) ? f : String(f).split(/[,，、]/);
  return [...new Set(arr.map(x => String(x).trim()).filter(Boolean))];
}

// ---- 写入 ----
export function addGrain({ category, text, date = '', source_id = '', families = [], status = 'active', tier, metadata = {} }) {
  if (!CATEGORIES.includes(category)) throw new Error(`category 必须是 ${CATEGORIES.join('/')} 之一`);
  if (!text || !String(text).trim()) throw new Error('text 不能为空');
  if (!STATUSES.includes(status)) throw new Error(`status 必须是 ${STATUSES.join('/')} 之一`);
  if (date && !isDate(date)) throw new Error('date 要是 YYYY-MM-DD');
  const warnings = [];
  if (category === 'experience' && !date) throw new Error('experience 必须带 date（发生的日期）');
  if (category === 'experience' && !source_id) warnings.push('experience 应该带 source_id 指向年轮记录（溯源），这条没带——之后可以用 update_grain 补上');
  if (tier && !TIERS.includes(tier)) throw new Error(`tier 必须是 ${TIERS.join('/')} 之一`);
  const d = load();
  const t = now();
  const g = {
    id: newId('g'),
    category,
    text: String(text).trim(),
    date: date || '',
    source_id: source_id || '',
    status,
    tier: category === 'feeling' ? (tier || 'observing') : (tier || null),
    families: normFamilies(families),
    heat: HEAT.DEFAULT,
    pinned: false,
    last_accessed: null,
    access_count: 0,
    created_at: t,
    updated_at: t,
    metadata: metadata && typeof metadata === 'object' ? metadata : {}
  };
  d.grains.push(g);
  save(d);
  return { grain: decorate(g), warnings };
}

export function updateGrain(id, patch = {}) {
  const d = load();
  const g = d.grains.find(x => x.id === id);
  if (!g) return null;
  if (patch.text !== undefined) {
    if (!String(patch.text).trim()) throw new Error('text 不能为空');
    g.text = String(patch.text).trim();
  }
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw new Error(`status 必须是 ${STATUSES.join('/')} 之一`);
    g.status = patch.status;
  }
  if (patch.families !== undefined) g.families = normFamilies(patch.families);
  if (patch.tier !== undefined) {
    if (patch.tier !== null && !TIERS.includes(patch.tier)) throw new Error(`tier 必须是 ${TIERS.join('/')} 之一`);
    g.tier = patch.tier;
  }
  if (patch.date !== undefined) {
    if (patch.date && !isDate(patch.date)) throw new Error('date 要是 YYYY-MM-DD');
    g.date = patch.date || '';
  }
  if (patch.source_id !== undefined) g.source_id = patch.source_id || '';
  if (patch.category !== undefined) {
    if (!CATEGORIES.includes(patch.category)) throw new Error(`category 必须是 ${CATEGORIES.join('/')} 之一`);
    g.metadata = { ...(g.metadata || {}), moved_from: g.category, moved_at: now() };
    g.category = patch.category;
  }
  if (patch.metadata && typeof patch.metadata === 'object') g.metadata = { ...(g.metadata || {}), ...patch.metadata };
  if (patch.pinned === true) {
    g.pinned = true;
    g.heat = clamp(g.heat + HEAT.BONUS.pin, HEAT.PIN_FLOOR, HEAT.MAX);
  } else if (patch.pinned === false) {
    g.pinned = false;
  }
  g.updated_at = now();
  save(d);
  return decorate(g);
}

export function setStatus(id, status) { return updateGrain(id, { status }); }

// ---- 触碰：每次被想起都升温 ----
// kind: search（搜索命中 +10）/ recall（被 recall 返回 +5）/ read（手动读，只记访问）/ cite（被引用写进日记 +15）/ pin（+20，同时 pinned=true）
export function touch(ids, kind = 'read') {
  const list = Array.isArray(ids) ? ids : [ids];
  if (!list.length) return [];
  const d = load();
  const touched = [];
  for (const g of d.grains) {
    if (!list.includes(g.id)) continue;
    g.last_accessed = now();
    g.access_count = (g.access_count || 0) + 1;
    const bonus = HEAT.BONUS[kind] || 0;
    if (kind === 'pin') g.pinned = true;
    if (bonus) g.heat = clamp((g.heat ?? HEAT.DEFAULT) + bonus, g.pinned ? HEAT.PIN_FLOOR : HEAT.MIN, HEAT.MAX);
    touched.push(decorate(g));
  }
  if (touched.length) save(d);
  return touched;
}

// ---- 读 ----
export function getGrain(id, { touchIt = true } = {}) {
  const d = load();
  const g = d.grains.find(x => x.id === id);
  if (!g) return null;
  if (touchIt) touch(id, 'read');
  return decorate(g);
}

export function allGrains() { return load().grains.map(decorate); }

export function countByStatus() {
  const out = { active: 0, background: 0, archived: 0, total: 0, low_heat: 0 };
  for (const g of load().grains) {
    out.total++;
    out[g.status] = (out[g.status] || 0) + 1;
    if (g.status !== 'archived' && g.heat < HEAT.CAUTIOUS) out.low_heat++;
  }
  return out;
}

// 醒来读的前台记忆：status != archived 且 heat > 20，按 heat 降序，总量控制在 maxChars 以内。
export function getActiveMemories({ maxChars = 30000, category } = {}) {
  const d = load();
  let pool = d.grains.filter(g => g.status !== 'archived' && (g.heat ?? HEAT.DEFAULT) > HEAT.ACTIVE_FLOOR);
  if (category) pool = pool.filter(g => g.category === category);
  pool.sort((a, b) => (b.heat - a.heat) || ((b.updated_at || '').localeCompare(a.updated_at || '')));
  const picked = [];
  let chars = 0;
  let truncated = 0;
  for (const g of pool) {
    const size = g.text.length + 60;
    if (chars + size > maxChars) { truncated++; continue; }
    chars += size;
    picked.push(g);
  }
  const lowHeat = d.grains.filter(g => g.status !== 'archived' && g.heat < HEAT.CAUTIOUS).length;
  const total = d.grains.filter(g => g.status !== 'archived').length;
  const notes = [];
  notes.push(`前台记忆 ${picked.length} 条（非归档共 ${total} 条），按热度降序。confidence：cite=${CONFIDENCE_HINT.cite}；cautious=${CONFIDENCE_HINT.cautious}；reference=${CONFIDENCE_HINT.reference}。`);
  if (truncated) notes.push(`还有 ${truncated} 条因为总量超过 ${maxChars} 字没放进来，用 search_grains 按需找。`);
  if (lowHeat) notes.push(`有 ${lowHeat} 条记忆 heat 已经低于 30（cautious 线以下），可以用 dream 的报告看看哪些要 pin、哪些放手。`);
  return {
    grains: picked.map(g => ({
      id: g.id, category: g.category, text: g.text, date: g.date || undefined,
      families: g.families.length ? g.families : undefined, heat: Math.round(g.heat * 10) / 10,
      confidence: confidenceOf(g.heat), tier: g.tier || undefined, pinned: g.pinned || undefined,
      status: g.status, source_id: g.source_id || undefined
    })),
    chars,
    notes
  };
}

// ---- 搜索 ----
export function searchGrains({ query, category, family, from, to, status, limit = 20, touchHits = true } = {}) {
  const d = load();
  let pool = d.grains;
  if (category) pool = pool.filter(g => g.category === category);
  if (family) pool = pool.filter(g => g.families.includes(family));
  if (status) pool = pool.filter(g => g.status === status);
  else pool = pool.filter(g => g.status !== 'archived' || !!query); // 归档的只有明确搜的时候才出现
  if (from) pool = pool.filter(g => (g.date || g.created_at.slice(0, 10)) >= from);
  if (to) pool = pool.filter(g => (g.date || g.created_at.slice(0, 10)) <= to);
  let scored;
  if (query && query.trim()) {
    scored = pool.map(g => ({ g, s: score(query, g.text + ' ' + g.families.join(' ')) })).filter(x => x.s > 0);
    scored.sort((a, b) => (b.s - a.s) || (b.g.heat - a.g.heat));
  } else {
    scored = pool.map(g => ({ g, s: 0 })).sort((a, b) => b.g.heat - a.g.heat);
  }
  const hits = scored.slice(0, limit);
  if (touchHits && query && hits.length) {
    // 命中即升温；返回升温之后的样子，不是升温前的快照
    const touched = Object.fromEntries(touch(hits.map(h => h.g.id), 'search').map(g => [g.id, g]));
    return hits.map(h => ({ ...(touched[h.g.id] || decorate(h.g)), score: h.s }));
  }
  return hits.map(h => ({ ...decorate(h.g), score: h.s }));
}

// ---- 家族 ----
export function listFamilies() {
  const counts = {};
  for (const g of load().grains) for (const f of g.families) counts[f] = (counts[f] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([family, count]) => ({ family, count }));
}

// ---- 关系（grain_links）----
export function addLink(from_id, to_id, relation) {
  if (!RELATIONS.includes(relation)) throw new Error(`relation 必须是 ${RELATIONS.join('/')} 之一`);
  const d = load();
  if (!d.grains.find(g => g.id === from_id)) throw new Error(`找不到 from_id=${from_id}`);
  if (!d.grains.find(g => g.id === to_id)) throw new Error(`找不到 to_id=${to_id}`);
  const dup = d.links.find(l => l.from_id === from_id && l.to_id === to_id && l.relation === relation);
  if (dup) return dup;
  const link = { id: d.links.length + 1, from_id, to_id, relation, created_at: now() };
  d.links.push(link);
  save(d);
  return link;
}
export function getLinks(id) {
  return load().links.filter(l => l.from_id === id || l.to_id === id);
}

// ---- 反证机制 ----
// 读一条纹理，同时把"反证"和"修复"一起带回来：
// 1. 跟它有 contradicts / repaired 关系的记忆
// 2. 如果它的家族标签带负面词（害怕她走、怀疑自己…），再把带正面词的家族里的记忆搜出来
export function getWithCounterevidence(id) {
  const d = load();
  const g = d.grains.find(x => x.id === id);
  if (!g) return null;
  touch(id, 'read');
  const byId = Object.fromEntries(d.grains.map(x => [x.id, x]));
  const linked = [];
  for (const l of d.links) {
    if (!['contradicts', 'repaired', 'supersedes'].includes(l.relation)) continue;
    const otherId = l.from_id === id ? l.to_id : (l.to_id === id ? l.from_id : null);
    if (!otherId || !byId[otherId]) continue;
    linked.push({ relation: l.relation, direction: l.from_id === id ? 'out' : 'in', grain: decorate(byId[otherId]) });
  }
  const negative = g.families.some(f => NEGATIVE_FAMILY_HINTS.some(h => f.includes(h)));
  let positive = [];
  if (negative) {
    positive = d.grains
      .filter(x => x.id !== id && x.status !== 'archived' && x.families.some(f => POSITIVE_FAMILY_HINTS.some(h => f.includes(h))))
      .sort((a, b) => b.heat - a.heat)
      .slice(0, 5)
      .map(decorate);
  }
  return {
    grain: decorate(g),
    negative_family: negative,
    counterevidence: linked,
    positive_memories: positive,
    note: negative
      ? '这条记忆的家族带负面标签，上面附了反证/修复记忆和正面家族的记忆，一起看，别只看这一条。'
      : (linked.length ? '附了跟这条有 contradicts/repaired/supersedes 关系的记忆。' : '没有关联的反证记忆。')
  };
}

// ---- 衰减（给梦境任务用）----
// 遍历所有 grains，heat -= 1；pinned 的不降到 20 以下；archived 的不参与。
// 返回刚跨过 cautious 线（从 >=30 降到 <30）的记忆列表，供下次醒来决定 pin 还是放手。
export function decayAll() {
  const d = load();
  const crossed = [];
  let decayed = 0;
  for (const g of d.grains) {
    if (g.status === 'archived') continue;
    const before = g.heat ?? HEAT.DEFAULT;
    const floor = g.pinned ? HEAT.PIN_FLOOR : HEAT.MIN;
    const after = clamp(before - HEAT.DAILY_DECAY, floor, HEAT.MAX);
    if (after !== before) decayed++;
    g.heat = after;
    if (before >= HEAT.CAUTIOUS && after < HEAT.CAUTIOUS) crossed.push(decorate(g));
  }
  save(d);
  return { decayed, crossed };
}
