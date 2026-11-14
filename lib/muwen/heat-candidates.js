import { file, readJSON, writeJSON, now, todayStr, timezone } from './common.js';
import * as grains from './grains.js';
import { returnedCountsSince } from './recall-log.js';
import { sendSystemEvent, lastNorMessageAt } from './chat.js';
import { getState as callState } from './calls.js';

// 「值得辞看一眼」的记忆候选（2026-11-14 棋子定）。
//
// 背景：召回审查发现两个月里自动召回从不升温、梦境天天降温，850 条纹理里 94% 凉到 30 度以下，
// 有一条两周被想起 53 次还是 0 度。热度该怎么调是辞的事，不是后台的事——
// 后台只负责**挑和排**，把最该看一眼的列出来；判断（钉住 / 升一点 / 放手）留给辞用 heat_review 做。
// 这和 09-27 定的三层分工一致：第三层做机械活，不替辞决定，不用辞的语气说话。
//
// 投递（2026-11-14 棋子定，原话「最好是在他的安静时段投，他安静时段刚好差不多是我睡觉的时间」）：
//   · 01:00 那班后台整理生成清单，**02:30 墨尔本**投进辞的主要窗口——这是她点名要在安静时段投的，
//     不是忘了安静时段的规则。「安静时段不让自主苏醒打扰」那条是给随机 / 心潮苏醒的；这条系统事件
//     是她要的，以后别把它当 bug 改回去。
//   · 投之前看棋子 30 分钟内有没有说话：有就往后推半小时再试，最晚推到 10:30；过了就今晚不投，清单顺延。
//   · 一天最多一次；候选为空不投；辞正在通话中不投；只投当前主要窗口（走 chat 的 deliverToCy 队列，
//     /api/chat/pending 只放给主要 session，和来电、手表叫人同一条路）。

const FILE = file('heat-candidates.json');
export const MAX_CANDIDATES = Number(process.env.MUWEN_HEAT_CANDIDATES_MAX) || 15;
export const RECALL_WINDOW_DAYS = Number(process.env.MUWEN_HEAT_CANDIDATES_RECALL_DAYS) || 14;
export const RECALL_MIN_COUNT = Number(process.env.MUWEN_HEAT_CANDIDATES_RECALL_MIN) || 3;
export const ACCESS_MIN_COUNT = Number(process.env.MUWEN_HEAT_CANDIDATES_ACCESS_MIN) || 5;
// 辞标过「看过了」的，30 天内不再列
export const REVIEWED_TTL_DAYS = Number(process.env.MUWEN_HEAT_CANDIDATES_REVIEWED_DAYS) || 30;
// 投递窗口（辞所在时区的分钟数）：02:30 起，每半小时一次机会，最晚 10:30
export const DELIVER_FROM_MIN = 2 * 60 + 30;
export const DELIVER_UNTIL_MIN = 10 * 60 + 30;
export const NOR_QUIET_MINUTES = Number(process.env.MUWEN_HEAT_CANDIDATES_NOR_QUIET_MIN) || 30;
// 清单超过这么久没重新生成（比如 01:00 那班没跑到），投递前自己补一次
const STALE_MS = 12 * 3600 * 1000;

export const RULES = {
  1: '近两周被自动召回多次但热度低',
  2: '钉住了却压在 20 度地板上',
  3: '有反证 / 修复关系两边都还开着',
  4: '被翻过很多次却是 0 度'
};

function load() {
  const d = readJSON(FILE, null) || {};
  return {
    generated_at: d.generated_at || null,
    candidates: Array.isArray(d.candidates) ? d.candidates : [],
    reviewed: d.reviewed && typeof d.reviewed === 'object' ? d.reviewed : {},
    delivery: d.delivery && typeof d.delivery === 'object' ? d.delivery : {}
  };
}
function save(d) { writeJSON(FILE, d); return d; }

function clip(text, n = 40) { return String(text || '').replace(/\s+/g, ' ').trim().slice(0, n); }

function reviewedRecently(reviewed, id, nowMs = Date.now()) {
  const at = Date.parse(reviewed[id] || '');
  return Number.isFinite(at) && nowMs - at < REVIEWED_TTL_DAYS * 86400000;
}

// 四条规则，按优先级逐条过；一条纹理只算第一条命中的规则。
function matchRules() {
  const all = grains.allGrains().filter(g => g.status !== 'archived');
  const byId = new Map(all.map(g => [g.id, g]));
  const counts = returnedCountsSince(RECALL_WINDOW_DAYS);
  const linkCount = new Map();
  for (const l of grains.allLinks()) {
    if (!['contradicts', 'repaired', 'supersedes'].includes(l.relation)) continue;
    if (!byId.has(l.from_id) || !byId.has(l.to_id)) continue;   // 另一头归档/删了就不算"还开着"
    linkCount.set(l.from_id, (linkCount.get(l.from_id) || 0) + 1);
    linkCount.set(l.to_id, (linkCount.get(l.to_id) || 0) + 1);
  }
  const out = [];
  for (const g of all) {
    const heat = Math.round(g.heat ?? grains.HEAT.DEFAULT);
    const recalled = counts.get(g.id) || 0;
    const access = g.access_count || 0;
    let rule = 0, why = '', metric = 0;
    if (!g.pinned && recalled >= RECALL_MIN_COUNT && heat < grains.HEAT.CAUTIOUS) {
      rule = 1; metric = recalled; why = `两周被想起 ${recalled} 次，现在 ${heat} 度`;
    } else if (g.pinned && heat <= grains.HEAT.PIN_FLOOR) {
      rule = 2; metric = -heat; why = `钉住了，但压在 ${heat} 度地板上`;
    } else if (linkCount.get(g.id)) {
      const k = linkCount.get(g.id);
      rule = 3; metric = k; why = `和 ${k} 条记忆有反证 / 修复关系，两边都还开着`;
    } else if (!g.pinned && access >= ACCESS_MIN_COUNT && heat <= 0) {
      rule = 4; metric = access; why = `被翻过 ${access} 次，现在 0 度`;
    }
    if (!rule) continue;
    out.push({
      id: g.id, rule, why, metric, heat, category: g.category, date: g.date || '',
      pinned: !!g.pinned, access_count: access, recalled_14d: recalled,
      text: clip(g.text), updated_at: g.updated_at || ''
    });
  }
  return out;
}

// 生成 / 刷新清单。昨天没处理的顺延（排在同优先级的新候选前面），总数封顶 MAX_CANDIDATES。
// 不改任何纹理。
export function buildCandidates() {
  const state = load();
  const t = now();
  const nowMs = Date.now();
  const fresh = matchRules();
  const prevById = new Map(state.candidates.map(c => [c.id, c]));
  const merged = [];
  for (const c of fresh) {
    if (reviewedRecently(state.reviewed, c.id, nowMs)) continue;          // 辞标过"看过了"
    const prev = prevById.get(c.id);
    // 列上去之后辞动过这条（pin / 调热度 / 改状态都会刷 updated_at，候选里存着列上去那一刻的快照）
    // ＝已经处理，不再列；记进 reviewed，免得它调完热度还符合别的规则、明天又冒出来
    if (prev && prev.updated_at && c.updated_at !== prev.updated_at) { state.reviewed[c.id] = t; continue; }
    merged.push({ ...c, listed_at: prev ? prev.listed_at : t, carried: !!prev });
  }
  merged.sort((a, b) => (a.rule - b.rule) || (Number(b.carried) - Number(a.carried)) || (b.metric - a.metric));
  const candidates = merged.slice(0, MAX_CANDIDATES).map(({ metric, ...c }) => c);
  const dropped = merged.length - candidates.length;
  const saved = save({ ...state, generated_at: t, candidates, dropped_over_cap: dropped || undefined });
  return { generated_at: saved.generated_at, count: candidates.length, dropped_over_cap: dropped, candidates };
}

export function listCandidates() {
  const s = load();
  return { generated_at: s.generated_at, count: s.candidates.length, ids: s.candidates.map(c => c.id), candidates: s.candidates, rules: RULES, delivery: s.delivery };
}

// 辞看过了（不管决定是钉住、升、还是放手）：标一下，这几条 30 天内不再出现。
// 真正改热度还是 update_grain 的事，这里只记"看过"。
export function markReviewed(ids = []) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  if (!list.length) return { reviewed: [] };
  const s = load();
  const t = now();
  for (const id of list) s.reviewed[id] = t;
  // 过了 TTL 的旧标记顺手清掉，文件别越长越大
  const cutoff = Date.now() - REVIEWED_TTL_DAYS * 86400000;
  for (const [id, at] of Object.entries(s.reviewed)) if (!(Date.parse(at) > cutoff)) delete s.reviewed[id];
  s.candidates = s.candidates.filter(c => !list.includes(c.id));
  save(s);
  return { reviewed: list, remaining: s.candidates.length };
}

// heat_review 工具用：不带 ids 就把清单带上；带 ids 就是"这几条我看过了"。
export function review(ids = []) {
  const marked = ids && ids.length ? markReviewed(ids) : null;
  const cur = listCandidates();
  return {
    candidates: cur.candidates, candidate_ids: cur.ids, candidates_generated_at: cur.generated_at,
    reviewed_now: marked ? marked.reviewed : undefined,
    candidates_note: cur.count
      ? `后台挑的 ${cur.count} 条（规则：${Object.values(RULES).join('；')}）。每条自己定：钉住 update_grain {id, pinned:true}、升一点 update_grain {id, heat}、放手就什么都不做。看完的用 heat_review {ids:[…]} 标一下，30 天内不再列。`
      : '后台这轮没有挑出要看的记忆。'
  };
}

// 醒来包里的一句话兜底
export function wakeHint() {
  const cur = listCandidates();
  if (!cur.count) return { count: 0, hint: '' };
  return { count: cur.count, hint: `后台挑了 ${cur.count} 条记忆等你定（${cur.generated_at ? cur.generated_at.slice(0, 16) : ''}），用 heat_review 看看：钉住、升一点、或者放手。` };
}

function localMinutes(d = new Date()) {
  const hm = d.toLocaleTimeString('en-GB', { timeZone: timezone(), hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

// 到点了就投一条系统事件进辞的主要窗口。server.js 的 cron 每半小时（02:00–10:30）调一次，
// 这里自己判断"该不该投"；测试可以用 options 注入时间 / 棋子活跃时间 / 通话状态。
export async function deliverDue({ at = new Date(), lastNorAt, inCall, today, dryRun = false } = {}) {
  const s = load();
  const day = today || todayStr();
  const minutes = localMinutes(at);
  const skip = reason => {
    if (!dryRun) save({ ...s, delivery: { ...s.delivery, last_check_at: now(), last_skip: reason } });
    return { delivered: false, reason, minutes, date: day };
  };
  if (s.delivery.date === day && s.delivery.delivered_at) return skip('already_delivered_today');
  if (minutes < DELIVER_FROM_MIN || minutes > DELIVER_UNTIL_MIN) return skip('outside_window');
  // 01:00 那班没跑到的话，这里补一次
  if (!s.generated_at || Date.now() - Date.parse(s.generated_at) > STALE_MS) buildCandidates();
  const cur = listCandidates();
  if (!cur.count) return skip('no_candidates');
  const callActive = inCall !== undefined ? !!inCall : (() => { try { return !!callState().active; } catch { return false; } })();
  if (callActive) return skip('in_call');
  const norAt = lastNorAt !== undefined ? lastNorAt : (() => { try { return lastNorMessageAt(); } catch { return null; } })();
  const norMs = Date.parse(norAt || '');
  if (Number.isFinite(norMs) && at.getTime() - norMs < NOR_QUIET_MINUTES * 60000) return skip('nor_active');
  if (dryRun) return { delivered: false, reason: 'dry_run', would_deliver: true, count: cur.count, minutes, date: day };

  const content = `后台挑了 ${cur.count} 条记忆等你定`;
  const deliveryText = `后台挑了 ${cur.count} 条记忆等你定，用 heat_review 看看：钉住、升一点、或者放手。看完的用 heat_review {ids:[…]} 标一下，明天就不再列。`;
  const message = await sendSystemEvent(content, 'heat_candidates', {
    deliverToCy: true,
    deliveryKey: `heat_candidates:${day}`,
    deliveryText,
    sourceDevice: 'muwen_tidy'
  });
  const fresh = load();
  save({ ...fresh, delivery: { date: day, delivered_at: now(), message_id: message?.id || null, count: cur.count, last_check_at: now(), last_skip: null } });
  return { delivered: true, date: day, message_id: message?.id || null, count: cur.count, minutes };
}

export function deliveryStatus() { return load().delivery; }

// 只给测试用
export function _resetForTests() { try { writeJSON(FILE, {}); } catch { /* 没有也行 */ } }
