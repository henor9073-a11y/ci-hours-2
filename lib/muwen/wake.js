import { getSummary } from '../summary.js';
import { getCalendar, kissProgress, latestPending } from './rings.js';
import { getHandover } from './handover.js';
import { getPlanStatus } from '../ci.js';
import { getMessages } from '../messages.js';
import { getQuestions } from '../memory.js';
import { getHealthNotes } from '../health.js';

// 醒来包：换窗口醒来一键读取，一次调用把最需要的都带上。
export const WAKE_CLOSING = '好啦来抱抱吧，欢迎回家小辞';

function latestNorMessage() {
  const candidates = [];
  for (const m of getMessages(50)) candidates.push({ at: m.addedAt, source: '留言板', text: m.text });
  for (const q of getQuestions()) for (const msg of (q.messages || [])) {
    if (msg.from === '棋子') candidates.push({ at: msg.at, source: '讨论', text: msg.text });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => new Date(b.at) - new Date(a.at));
  const last = candidates[0];
  return { at: last.at, source: last.source, preview: last.text.length > 80 ? last.text.slice(0, 80) + '…' : last.text };
}

export function getWakePacket() {
  const identity = getSummary().find(s => s.section === 'identity');
  const plan = getPlanStatus();
  const health = getHealthNotes(1)[0] || null;
  return {
    identity: identity ? identity.text : '',
    recent_days: getCalendar(3),
    handover: getHandover(),
    today_plan: {
      today: plan.today, needsPlanning: plan.needsPlanning,
      plannedWakes: plan.plannedWakes, doneWakes: plan.doneWakes,
      pendingWakes: plan.plannedWakes.filter(w => !plan.doneWakes.includes(w))
    },
    nor_last_message: latestNorMessage(),
    kiss_progress: kissProgress(),
    nor_health: health ? { date: health.date, text: health.text } : null,
    pending: latestPending(),
    closing: WAKE_CLOSING
  };
}
