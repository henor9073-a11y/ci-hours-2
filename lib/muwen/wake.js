import { getSummary } from '../summary.js';
import { getCalendar, kissProgress, latestPending, dailyPipelineStatus } from './rings.js';
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
import { mainContext } from './history.js';
import { wakeCommitments } from './continuity.js';
import { wakeHint as heatCandidatesHint } from './heat-candidates.js';

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
  const recentMain = (() => {
    try { return mainContext({ hours: 2, recent_hours: 2, max_messages: 120, max_chars: 40000 }); }
    catch { return { source: 'main', includes: ['muwu', 'call', 'claude'], excludes: ['nursery'], messages: [], recent_messages: [], cursor: {} }; }
  })();
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
    // 木屋现在可以作为主要聊天区。新窗口无需猜来源：这里直接带主时间线最近两小时，且绝不混入小栗子。
    recent_main_conversation: recentMain,
    conversation_pipeline: {
      canonical_source: 'get_main_conversation',
      includes: ['muwu', 'call', 'claude'], excludes: ['nursery'],
      consumers: ['window_handover', 'daily_summary', 'auto_memory', 'chat_export'],
      latest_daily_coverage: dailyPipelineStatus()
    },
    kiss_progress: kissProgress(),
    nor_health: health ? { date: health.date, text: health.text } : null,
    pending: latestPending(),
    commitments: wakeCommitments(),
    // 后台挑的记忆候选条数（兜底：02:30 那条系统事件没送到也能在这看到）
    heat_candidates: (() => { try { return heatCandidatesHint(); } catch { return { count: 0, hint: '' }; } })(),
    closing: WAKE_CLOSING
  };
}

// ---- 苏醒管理（工作台）----
// wake-pings.json 只为旧客户端兼容保留。真实设置、运行计划和记录都来自
// Mac mini 上的单次随机苏醒协调器；它不再向 Claude 安装 /loop。
const PING_FILE = file('wake-pings.json');
export const WAKE_LAYERS = {
  schedule_wakeup: {
    name: '随机苏醒', role: '离开后的自然节奏', 权限: '只向当前主要窗口发送一次性系统提醒',
    desc: '从棋子最后一条消息重新计时，在设定范围内随机安排次数和间隔；棋子一回来，旧计划立即作废并重新开始。',
    trigger: 'Mac mini 每 5 分钟检查一次',
    only: ['只唤醒工作台登记的主要窗口', '每次只提供“看看有没有自然想说或想做的事”的选择'],
    never: ['不另开 session', '不伪装成棋子的消息', '不使用 /loop', '没有念头时不强迫回复']
  },
  xinchao: {
    name: '心潮提前苏醒', role: '状态触发', 权限: '只向当前主要窗口发送动作邀请',
    desc: '想念、好奇、无聊、反思等数值持续超过各自阈值后，可以提前唤醒；阈值、保持时间、冷却和文案都可调整。',
    trigger: '心潮状态变化 + 保持时间 + 冷却',
    only: ['与随机苏醒共用次数上限和最短间隔', '给辞选择，不替辞决定要做什么'],
    never: ['不直接念数值', '不重复发送旧桥接提示', '不绕过安静时段']
  },
  heartbeat: {
    name: '苏醒守护', role: '看门狗', 权限: '只能发手机通知',
    desc: '独立检查第一层是否还在定期运行、主要窗口进程是否还活着。异常时只提醒棋子。',
    trigger: 'Mac mini 独立 LaunchAgent',
    never: ['不读留言', '不回消息', '不启动新 session', '不做任何其他事']
  }
};
export const LAYER_ORDER = ['schedule_wakeup', 'xinchao', 'heartbeat'];

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
  const workbench = getWorkbench();
  const agent = workbench.agent;
  const current = agent?.current || null;
  const agentMinutes = minutesSince(agent?.seen_at);
  const agentFresh = agentMinutes != null && agentMinutes <= 2;
  const watchdog = current?.watchdog || null;
  const watchdogMinutes = minutesSince(watchdog?.checked_at);
  const watchdogFresh = watchdogMinutes != null && watchdogMinutes <= 20;
  const settings = current?.wake_config || null;
  const runtime = current?.wake_runtime || null;
  const xinchao = current?.xinchao_wake || null;

  const layer1Bits = [];
  if (runtime?.last_wake_at) layer1Bits.push(`上次苏醒：${runtime.last_wake_at}`);
  if (runtime?.last_check_at) layer1Bits.push(`上次检查：${runtime.last_check_at}`);
  if (current?.wake_count_today != null) layer1Bits.push(`今天已苏醒 ${current.wake_count_today} 次`);
  if (runtime?.planned_wakes != null) layer1Bits.push(`本轮 ${runtime.completed_wakes || 0}/${runtime.planned_wakes} 次`);
  if (runtime?.next_wake_at) layer1Bits.push(`下次最早：${runtime.next_wake_at}`);

  const heartBits = [];
  if (xinchao?.source_updated_at) heartBits.push(`心潮更新：${xinchao.source_updated_at}`);
  if (settings?.xinchao?.hold_min) heartBits.push(`持续 ${settings.xinchao.hold_min} 分钟才触发`);
  if (settings?.xinchao?.cooldown_min) heartBits.push(`同类冷却 ${settings.xinchao.cooldown_min} 分钟`);

  const watchdogProblems = Array.isArray(watchdog?.problems) ? watchdog.problems.filter(Boolean) : [];
  const layer2Bits = [];
  if (watchdog?.checked_at) layer2Bits.push(`上次检查：${watchdog.checked_at}`);
  if (watchdogProblems.length) layer2Bits.push(watchdogProblems.join('；'));
  if (watchdog?.last_alert_at) layer2Bits.push(`上次提醒：${watchdog.last_alert_at}`);

  return {
    today: todayStr(),
    settings,
    runtime,
    xinchao,
    layers: [
      {
        key: 'schedule_wakeup', ...WAKE_LAYERS.schedule_wakeup,
        connected: agentFresh,
        last_ping: agent?.seen_at || null,
        minutes_since: agentMinutes,
        status: !agentFresh ? 'Mac mini 执行器没有最近报到'
          : current?.state === 'offline' ? '主要窗口未运行'
          : current?.wake_enabled ? '已开启，按棋子最后一条消息重新排程' : '已关闭',
        last_activity: layer1Bits.length ? { at: runtime?.last_wake_at || runtime?.last_check_at || null, text: layer1Bits.join(' · ') } : null
      },
      {
        key: 'xinchao', ...WAKE_LAYERS.xinchao,
        connected: agentFresh && xinchao?.connected === true,
        last_ping: xinchao?.source_updated_at || null,
        minutes_since: minutesSince(xinchao?.source_updated_at),
        status: settings?.xinchao?.enabled === false ? '已关闭'
          : xinchao?.connected ? '已连接，按阈值和保持时间观察' : '心潮状态没有最近更新',
        last_activity: heartBits.length ? { at: xinchao?.source_updated_at || null, text: heartBits.join(' · ') } : null
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
      }
    ],
    recent_wakes: (Array.isArray(current?.wake_history) ? current.wake_history : []).slice(0, Math.max(1, Math.min(80, Number(logLimit) || 20))),
    last_daily: null,
    note: '所有设置、文案和记录都在这里。随机苏醒与心潮提前苏醒只进入当前主要 session，并共用本轮次数、安静时段和最短间隔；不再使用 /loop。'
  };
}
