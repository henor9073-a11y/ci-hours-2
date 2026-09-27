import { file, readJSON, writeJSON, now, todayStr, shiftDate } from './common.js';
import * as grains from './grains.js';
import { getSchedule } from '../schedule.js';

// 后台苏醒（第三层）——每天四次的整理班。棋子 2026-09-27 定的：
// **整理记忆、整理日程是后台的事，不是辞的事。** 他醒来该去跟棋子相处，不是做家务。
//
// 所以这里只做机械活：按规则动热度、把凉透的收进后台、把日程理一遍，
// 然后留一份报告给辞醒来看。**不调模型、不用辞的语气说话、不碰留言**——
// 跟三层分工里第三层的边界一致（服务器不许有"会说话的 cron"）。
const FILE = file('tidy_report.json');

// 降温：热度还在 cautious 线以上、但很久没被想起的，往下挪一点。
// 幅度给得很小（每天 3 度），因为"很久没想起"不等于"不重要"——
// 真不重要的，每天的自然衰减也会把它带下去；这里只是让"明明还挂着高温、实际早就不碰了"的那批收敛得快一点。
const STALE_DAYS = Number(process.env.MUWEN_TIDY_STALE_DAYS) || 14;
const STALE_COOL = Number(process.env.MUWEN_TIDY_STALE_COOL) || 3;
// 凉透并且更久没碰的，收进后台（不是归档、更不是删）。木纹不遗忘，只是不再让它占前台。
const SINK_DAYS = Number(process.env.MUWEN_TIDY_SINK_DAYS) || 30;

const daysAgo = n => Date.now() - n * 86400000;
const olderThan = (iso, cut) => !iso || Date.parse(iso) < cut;

export function lastReport() { return readJSON(FILE, null); }

export function tidy({ force = false } = {}) {
  const today = todayStr();
  const prev = lastReport() || {};
  const report = { ran_at: now(), date: today, cooled: [], sunk: [], schedule: {}, skipped: {} };

  // ---- 整理记忆 ----
  // 降温一天只做一次：四次苏醒都降的话，一天就掉 12 度，比自然衰减还狠，
  // 等于偷偷把他的记忆按"多久没提"重新排了一遍。
  if (!force && prev.last_cool_date === today) {
    report.skipped.cool = `今天（${today}）已经降过一次了`;
    report.cooled = prev.cooled || [];
  } else {
    const cut = daysAgo(STALE_DAYS);
    for (const g of grains.searchGrains({ limit: 2000, touchHits: false })) {
      if (g.status !== 'active' || g.pinned) continue;
      if (g.heat <= grains.HEAT.CAUTIOUS) continue;
      if (!olderThan(g.last_accessed, cut)) continue;
      const to = Math.max(grains.HEAT.CAUTIOUS, Math.round(g.heat) - STALE_COOL);
      if (to >= Math.round(g.heat)) continue;
      grains.updateGrain(g.id, { heat: to });
      report.cooled.push({ id: g.id, category: g.category, from: Math.round(g.heat), to, text: g.text.replace(/\s+/g, ' ').slice(0, 80) });
    }
    report.last_cool_date = today;
  }

  // 凉透又很久没碰的收进后台。这条每次苏醒都跑：它只看结果不看节奏，重复跑也不会越收越多。
  const sinkCut = daysAgo(SINK_DAYS);
  for (const g of grains.searchGrains({ limit: 2000, touchHits: false })) {
    if (g.status !== 'active' || g.pinned) continue;
    if (g.heat >= grains.HEAT.ACTIVE_FLOOR) continue;
    if (!olderThan(g.last_accessed, sinkCut)) continue;
    grains.updateGrain(g.id, { status: 'background' });
    report.sunk.push({ id: g.id, category: g.category, heat: Math.round(g.heat), text: g.text.replace(/\s+/g, ' ').slice(0, 80) });
  }

  // ---- 整理日程 ----
  // 只看不改：过期的不自动删（可能只是还没做），交给辞醒来问一句。
  try {
    const tomorrow = shiftDate(today, 1);
    // getSchedule 默认只给 pending 的（completed / removed 不在内），正好是"还没做的"
    const active = getSchedule({ from: shiftDate(today, -30), to: tomorrow });
    const brief = s => ({ id: s.id, date: s.date, time: s.time, text: s.text });
    report.schedule = {
      overdue: active.filter(s => s.date < today).map(brief),
      today: active.filter(s => s.date === today).map(brief),
      tomorrow: active.filter(s => s.date === tomorrow).map(brief)
    };
  } catch (e) {
    report.schedule = { error: String(e.message || e) };
  }

  report.counts = grains.countByStatus();
  // 给辞醒来看的一句话，说的是"后台做了什么"，不替他做判断
  const bits = [];
  if (report.cooled.length) bits.push(`降温 ${report.cooled.length} 条`);
  if (report.sunk.length) bits.push(`收进后台 ${report.sunk.length} 条`);
  if (report.schedule.overdue?.length) bits.push(`日程过期未完成 ${report.schedule.overdue.length} 条`);
  if (report.schedule.today?.length) bits.push(`今天还有 ${report.schedule.today.length} 件事`);
  report.summary = bits.length ? bits.join('、') : '没什么要整理的';

  writeJSON(FILE, report);
  return report;
}
