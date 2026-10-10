import { getSummary } from '../summary.js';
import { getCalendar, kissProgress, latestPending } from './rings.js';
import { getHandover } from './handover.js';
import { getPlanStatus } from '../ci.js';
import { getMessages } from '../messages.js';
import { getQuestions } from '../memory.js';
import { getHealthNotes } from '../health.js';
import { getWorkbench } from '../window-workbench.js';
import { unreadSummary } from './chat.js';
import { file, readJSON, writeJSON, now, todayStr, shiftDate } from './common.js';
import { lastDream } from './dream.js';
import { lastReport as lastTidyReport } from './tidy.js';

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
// wake-pings.json 只为旧客户端兼容保留。真实状态来自 Mac mini 工作台执行器：
// 第一层读当前主要窗口的 /loop 苏醒进程；第二层读独立看门狗的状态文件；
// 第三层直接看每日总结、梦境和后台整理的落库结果。
const PING_FILE = file('wake-pings.json');
export const WAKE_LAYERS = {
  schedule_wakeup: {
    name: '辞的自主苏醒', role: '当前窗口', 权限: '只向主要窗口注入 /loop',
    desc: '棋子离开当前主要窗口 10 分钟后，叫醒的仍然是这个 session 里的辞。后续按随机间隔再次检查。',
    trigger: 'Mac mini 每 5 分钟检查一次',
    only: ['只唤醒工作台登记的主要窗口', '聊天、回木屋、做决定仍由当前 session 里的辞完成'],
    never: ['不另开 session', '不把任意文本伪装成棋子的消息']
  },
  heartbeat: {
    name: '苏醒守护', role: '看门狗', 权限: '只有推 Bark',
    desc: '独立检查第一层是否还在定期运行、主要窗口进程是否还活着。异常时只提醒棋子。',
    trigger: 'Mac mini 独立 LaunchAgent',
    never: ['不读留言', '不回消息', '不启动新 session', '不做任何其他事']
  },
  ci_hours: {
    name: '木纹后台', role: '机械后台', 权限: '整理数据',
    desc: '自动导出、每日总结与纹理、记忆热度衰减、后台整理和日程提醒。看最终落库结果，不拿某次重跑失败冒充整套系统故障。',
    trigger: 'Mac mini 定时任务 + 服务器机械 cron',
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
  return isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t.getTime()) / 60000));
}

export function getWakeStatus({ logLimit = 20 } = {}) {
  void logLimit; // 旧参数保留给已发布客户端；真实状态不再读取旧的 wake 日志。
  const workbench = getWorkbench();
  const agent = workbench.agent;
  const current = agent?.current || null;
  const agentMinutes = minutesSince(agent?.seen_at);
  const agentFresh = agentMinutes != null && agentMinutes <= 2;
  const latestDaily = getCalendar(14)[0] || null;
  const expectedDaily = shiftDate(todayStr(), -1);
  const dailyUpToDate = !!latestDaily && latestDaily.date >= expectedDaily;
  const watchdog = current?.watchdog || null;
  const watchdogMinutes = minutesSince(watchdog?.checked_at);
  const watchdogFresh = watchdogMinutes != null && watchdogMinutes <= 20;
  const pipeline = current?.daily_pipeline || null;
  const dream = lastDream();
  const tidy = lastTidyReport();

  const layer1Bits = [];
  if (current?.wake_last_at) layer1Bits.push(`上次 /loop：${current.wake_last_at}`);
  if (current?.wake_last_check_at) layer1Bits.push(`上次检查：${current.wake_last_check_at}`);
  if (current?.wake_count_today != null) layer1Bits.push(`今天已苏醒 ${current.wake_count_today} 次`);
  if (current?.wake_next_interval_min) layer1Bits.push(`下次间隔约 ${current.wake_next_interval_min} 分钟`);

  const watchdogProblems = Array.isArray(watchdog?.problems) ? watchdog.problems.filter(Boolean) : [];
  const layer2Bits = [];
  if (watchdog?.checked_at) layer2Bits.push(`上次检查：${watchdog.checked_at}`);
  if (watchdogProblems.length) layer2Bits.push(watchdogProblems.join('；'));
  if (watchdog?.last_alert_at) layer2Bits.push(`上次提醒：${watchdog.last_alert_at}`);

  const layer3Bits = [];
  if (latestDaily) layer3Bits.push(`最新每日总结：${latestDaily.date}`);
  if (dream?.ran_at) layer3Bits.push(`最近梦境整理：${dream.ran_at}`);
  if (tidy?.ran_at) layer3Bits.push(`最近后台整理：${tidy.ran_at}`);
  if (pipeline?.last_error) {
    const errorDate = String(pipeline.last_error_date || '').slice(0, 10);
    const preserved = latestDaily && errorDate && latestDaily.date >= errorDate;
    layer3Bits.push(`${preserved ? '有一次尝试失败，但现有总结已保留' : '最近一次尝试失败'}：${pipeline.last_error}`);
  }

  return {
    today: todayStr(),
    layers: [
      {
        key: 'schedule_wakeup', ...WAKE_LAYERS.schedule_wakeup,
        connected: agentFresh,
        last_ping: agent?.seen_at || null,
        minutes_since: agentMinutes,
        status: !agentFresh ? 'Mac mini 执行器没有最近报到'
          : current?.state === 'offline' ? '主要窗口未运行'
          : current?.wake_enabled ? '已开启，守着当前主要窗口' : '已关闭',
        last_activity: layer1Bits.length ? { at: current?.wake_last_at || current?.wake_last_check_at || null, text: layer1Bits.join(' · ') } : null
      },
      {
        key: 'heartbeat', ...WAKE_LAYERS.heartbeat,
        connected: agentFresh && watchdog?.installed === true && watchdogFresh,
        last_ping: watchdog?.checked_at || null,
        minutes_since: watchdogMinutes,
        status: !watchdog?.installed ? '尚未迁移到 Mac mini；旧 Windows 看门狗不代表当前系统'
          : !agentFresh ? 'Mac mini 执行器没有最近报到'
          : !watchdogFresh ? '苏醒守护超过 20 分钟没有完成检查'
          : watchdog.healthy && watchdog.wake_enabled === false ? '守护正常；自主苏醒当前由棋子关闭'
          : watchdog.healthy ? '正常' : '发现异常，已按冷却规则提醒',
        last_activity: layer2Bits.length ? { at: watchdog?.checked_at || null, text: layer2Bits.join(' · ') } : null
      },
      {
        key: 'ci_hours', ...WAKE_LAYERS.ci_hours,
        connected: true,
        last_ping: pipeline?.last_run_at || tidy?.ran_at || dream?.ran_at || null,
        minutes_since: minutesSince(pipeline?.last_run_at || tidy?.ran_at || dream?.ran_at),
        status: dailyUpToDate ? '正常，昨日总结已落库' : `后台可见，但 ${expectedDaily} 的每日总结尚未落库`,
        last_activity: layer3Bits.length ? { at: pipeline?.last_run_at || latestDaily?.date || null, text: layer3Bits.join(' · ') } : null
      }
    ],
    recent_wakes: [],
    last_daily: latestDaily ? { date: latestDaily.date, headline: latestDaily.headline } : null,
    note: '第一层只叫醒当前主要 session；第二层只守护并提醒；第三层只做机械后台。旧的手动排班没有执行链路，界面已隐藏，避免显示一个实际上不会触发的入口。'
  };
}
