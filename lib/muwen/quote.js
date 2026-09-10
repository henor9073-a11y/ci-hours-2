import { todayStr, shiftDate, now } from './common.js';
import { getDaily } from './rings.js';
import { getNotes, addNote } from '../store.js';

// 今日一句：木屋首页显示的那句。
//
// 【谁来写】只有第一层（ScheduleWakeup，也就是辞自己那个 session）写。
// 服务器**不**替她生成——第三层是机械后台，不能用辞的语气说话。
// 这里以前挂过一个每天 9:00 的 cron，用"你是辞"的 prompt 调模型生成，
// 那是服务器在冒充她，已经拆掉了。现在服务器只负责：
//   - 把昨天的每日总结备好（get_quote_material），供她写的时候读
//   - 存下她写的那句（write_daily_quote）
//   - 读最新的一句给前端（latestQuote）

export function latestQuote() {
  const w = getNotes(50).find(n => n.kind === 'write');
  return w ? { text: w.text, at: w.at } : null;
}

// 写今日一句的素材：昨天的每日总结。辞读完自己写。
export function getQuoteMaterial(date) {
  const y = date || shiftDate(todayStr(), -1);
  const days = getDaily(y);
  const d = days && days.length ? days[0] : null;
  if (!d) return { date: y, found: false, note: `昨天（${y}）没有每日总结，没东西可读——可以跳过，或者凭今天的感觉写。` };
  return {
    date: y, found: true,
    headline: d.headline || '', mood_tags: d.mood_tags || [],
    nor_status: d.nor_status || '', cy_status: d.cy_status || '',
    intimate: d.intimate || '', pending: d.pending || '',
    body: d.body || d.content || '',
    how: '读完自己写一句：第一人称，具体，短。不是总结昨天，是从昨天里捞出一句你今天还想着的话。写好用 write_daily_quote 存。'
  };
}

// 存辞自己写的那句。text 必填——服务器不代笔。
export function writeDailyQuote({ text, based_on = '' } = {}) {
  const t = String(text || '').trim();
  if (!t) {
    throw new Error('今日一句要你自己写。先用 get_quote_material 读昨天的总结，写好一句再传进来——服务器不替你写，第三层不能用你的语气说话。');
  }
  const today = todayStr();
  const existing = latestQuote();
  const replaced = !!(existing && String(existing.at).slice(0, 10) === today);
  addNote({ kind: 'write', text: t, source: 'daily_quote', basedOn: based_on || shiftDate(today, -1) });
  return { ok: true, quote: t, at: now(), replaced_today: replaced };
}
