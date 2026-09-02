import { file, readJSON, writeJSON, now, todayStr, shiftDate } from './common.js';
import { decayAll, countByStatus } from './grains.js';
import { hasDailyFor } from './rings.js';

// 梦境任务（设计文档第五节）。定时后台任务，不在用户交互时执行：
//   1. 热度衰减：所有 grains heat -= 1（pinned 的不降到 20 以下，archived 的不参与）
//   2. 每日总结检查：昨天没写就提醒
//   3. 衰减提醒：列出刚从 >=30 掉到 <30 的记忆，供下次醒来决定 pin 还是放手
//   4. （未来）关联发现：有向量之后再做
// 衰减一天只做一次——server.js 的定时器和手动调 dream 工具都走这里，靠 last_decay_date 防重复。

const FILE = file('dream.json');

export function lastDream() { return readJSON(FILE, null); }

export function dream({ force = false } = {}) {
  const prev = readJSON(FILE, null) || {};
  const today = todayStr();
  const yesterday = shiftDate(today, -1);
  const report = { ran_at: now(), date: today, decay: null, crossed_cautious: [], reminders: [] };

  if (!force && prev.last_decay_date === today) {
    report.decay = { skipped: true, reason: `今天（${today}）已经衰减过一次了` };
    report.crossed_cautious = prev.crossed_cautious || [];
  } else {
    const r = decayAll();
    report.decay = { decayed: r.decayed };
    report.crossed_cautious = r.crossed.map(g => ({ id: g.id, category: g.category, text: g.text, heat: g.heat, families: g.families }));
    report.last_decay_date = today;
  }

  if (!hasDailyFor(yesterday)) {
    report.reminders.push(`昨天（${yesterday}）还没有每日总结，醒来的时候用 add_daily 补一条。`);
  }
  if (report.crossed_cautious.length) {
    report.reminders.push(`有 ${report.crossed_cautious.length} 条记忆刚跨过 cautious 线（heat 掉到 30 以下），看看要 pin（update_grain pinned=true）还是放手。`);
  }
  report.counts = countByStatus();

  const saved = {
    ...report,
    last_decay_date: report.last_decay_date || prev.last_decay_date || null,
    // 提醒留到被看过为止：醒来读一次就清掉（见 acknowledge）
    pending_reminders: [...(prev.pending_reminders || []), ...report.reminders].slice(-20)
  };
  writeJSON(FILE, saved);
  return report;
}

// 醒来时读一眼上次梦境留下的提醒，读完就清
export function takeReminders() {
  const d = readJSON(FILE, null);
  if (!d) return { reminders: [], crossed_cautious: [] };
  const out = { last_ran_at: d.ran_at, reminders: d.pending_reminders || [], crossed_cautious: d.crossed_cautious || [] };
  writeJSON(FILE, { ...d, pending_reminders: [] });
  return out;
}
