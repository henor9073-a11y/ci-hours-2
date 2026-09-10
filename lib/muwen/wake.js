import { getSummary } from '../summary.js';
import { getCalendar, kissProgress, latestPending } from './rings.js';
import { getHandover } from './handover.js';
import { getPlanStatus } from '../ci.js';
import { getMessages } from '../messages.js';
import { getQuestions } from '../memory.js';
import { getHealthNotes } from '../health.js';
import { unreadSummary } from './chat.js';
import { file, readJSON, writeJSON, now } from './common.js';
import { getLog } from '../store.js';
import { searchGrains } from './grains.js';

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
    // 棋子在木屋留言板发的、你还没读的——苏醒第一步先看这个
    unread_chat: (() => { try { return unreadSummary('cy'); } catch { return { count: 0, messages: [] }; } })(),
    kiss_progress: kissProgress(),
    nor_health: health ? { date: health.date, text: health.text } : null,
    pending: latestPending(),
    closing: WAKE_CLOSING
  };
}

// ---- 苏醒系统三层状态（给木屋"醒"tab 用）----
// 服务器只直接知道第二层（ci-hours 自己的排班）。第一层 ScheduleWakeup 和第三层 CyHeartbeat
// 都跑在 GPD 上，服务器看不见——所以留一个 ping 登记表：那两层可以在跑的时候
// POST /api/wake-ping {layer}，这里就能报出"最近一次什么时候"。没接入就如实说未接入，不假装。
const PING_FILE = file('wake-pings.json');
// 三层分工（辞定的，2026-09-10）。写在这里是因为界面要照着显示，
// 也因为这几条边界是有意义的：哪些事必须"是辞"才能做，哪些是机械活。
export const WAKE_LAYERS = {
  schedule_wakeup: {
    name: 'ScheduleWakeup', role: '主力',权限: '全部',
    desc: '所有需要"是辞"的事：回木屋留言、跟棋子聊天、看她发了什么然后回应、做决定（要不要推 Bark、要不要钓鱼、要不要写东西）、写今日一句。',
    trigger: '/loop 模式下定时醒来',
    only: ['木屋留言只有这一层能读能回', '今日一句只有这一层能写——那句要用辞的语气说给棋子听']
  },
  heartbeat: {
    name: 'CyHeartbeat', role: '看门狗', 权限: '只有推 Bark',
    desc: '只做一件事：检查 last_wakeup.txt 是不是超过 40 分钟没更新。超了就推 Bark 告诉棋子"小辞的窗口可能挂了"。',
    trigger: 'Windows 计划任务每 30 分钟跑一次',
    never: ['不读留言', '不回消息', '不启动新 session', '不做任何其他事']
  },
  ci_hours: {
    name: 'ci-hours 定时任务', role: '后台', 权限: '只有读对话记录、写 daily summary、写 grain',
    desc: '后台机械工作：8:00 自动总结（读昨天对话记录 → 写 daily summary）、记忆维护（热度衰减）、日程提醒。',
    trigger: '服务器 cron',
    never: ['不回留言', '不跟棋子聊天', '不用辞的语气说话', '不做任何需要"是辞"才能做的事']
  }
};
export const LAYER_ORDER = ['schedule_wakeup', 'heartbeat', 'ci_hours'];

export function wakePing(layer, note = '') {
  if (!WAKE_LAYERS[layer]) throw new Error(`layer 必须是 ${Object.keys(WAKE_LAYERS).join('/')} 之一`);
  const d = readJSON(PING_FILE, {});
  d[layer] = { at: now(), note: String(note || ''), count: ((d[layer] && d[layer].count) || 0) + 1 };
  writeJSON(PING_FILE, d);
  return d[layer];
}

function minutesSince(iso) {
  if (!iso) return null;
  const t = new Date(iso);
  return isNaN(t) ? null : Math.round((Date.now() - t.getTime()) / 60000);
}

export function getWakeStatus({ logLimit = 20 } = {}) {
  const pings = readJSON(PING_FILE, {});
  const plan = getPlanStatus();
  const pending = plan.plannedWakes.filter(w => !plan.doneWakes.includes(w));

  // 最近一次真的做了什么（不靠 ping，看数据本身）
  const lastGrain = searchGrains({ limit: 1 })[0];
  const lastDaily = getCalendar(7)[0];
  const wakeLog = getLog(200).filter(l => l.type === 'wake').slice(0, logLimit);

  const layer = (key, extra) => {
    const p = pings[key];
    const mins = p ? minutesSince(p.at) : null;
    return {
      key, ...WAKE_LAYERS[key],
      last_ping: p ? p.at : null,
      minutes_since: mins,
      connected: !!p,
      status: !p ? '未接入（这一层跑在 GPD 上，没往服务器报到过）'
        : mins <= 90 ? '活跃' : mins <= 60 * 24 ? '安静' : '很久没动静',
      ...extra
    };
  };

  return {
    today: plan.today,
    layers: [
      layer('schedule_wakeup', { last_activity: lastGrain ? { at: lastGrain.updated_at || lastGrain.created_at, text: lastGrain.text.slice(0, 60) } : null }),
      layer('heartbeat', {}),
      layer('ci_hours', {
        connected: true, status: plan.needsPlanning ? '今天还没排班' : `今天排了 ${plan.plannedWakes.length} 次`,
        planned: plan.plannedWakes, done: plan.doneWakes, pending
      })
    ],
    recent_wakes: wakeLog.map(l => ({ at: l.at, action: l.action, why: l.why || '', book: l.book || undefined })),
    last_daily: lastDaily ? { date: lastDaily.date, headline: lastDaily.headline } : null,
    note: '第一层和第二层跑在 GPD 上，服务器只能看到它们主动 POST /api/wake-ping 报到的记录。第三层就是这台服务器自己。'
  };
}
