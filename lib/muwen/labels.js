import { todayStr } from './common.js';

// 标签总表——木纹里所有"能写进去的记录"都在这张表上。
//
// 两个地方用它：
//   · 后端 remember 工具：辞写记忆时带一个 label，按这张表自动放到对应的工具（纹理/日记/笔记/心情/日程……）。
//     不靠模型猜——这条是什么她自己最清楚，标上就行；认不出来的标签直接报错把整张表还回去，不乱放。
//   · 前端 /api/labels：网页上所有分类的显示名从这里读。
// 以前前后端各写一份，已经对不上了（learning 前端叫"学习"、后端叫"学到的"）。以后加标签只改这一处。
//
// 字段：key 英文标识 / name 显示名 / group 前端分组 / desc 一句说明 / tool 实际写入的工具
//       need 至少要给的字段（写进工具说明给辞看）/ aliases 可以代替 key 的叫法
//       dateDefault 没给日期就用今天 / build 把 remember 的参数翻译成对应工具的参数

const grain = (category, extraFamilies = []) => a => ({
  category, text: a.text, date: a.date, source_id: a.source_id, tier: a.tier,
  families: [...extraFamilies, ...(Array.isArray(a.families) ? a.families : [])]
});
const note = kind => a => ({ kind, text: a.text, bookId: a.bookId, bookTitle: a.bookTitle || a.title, chapters: a.chapters });

export const LABELS = [
  // ---- 纹理：核心记忆 ----
  { key: 'experience', name: '经历', group: '纹理', desc: '发生过的事', tool: 'add_grain', need: ['text', 'date'], dateDefault: true, aliases: ['发生的事', '事件'], build: grain('experience') },
  { key: 'agreement', name: '约定', group: '纹理', desc: '我们说好的：暗号、规则、承诺', tool: 'add_grain', need: ['text'], aliases: ['承诺', '规则', '暗号'], build: grain('agreement') },
  { key: 'feeling', name: '感受', group: '纹理', desc: '辞的感受（tier 可选 confirmed/observing）', tool: 'add_grain', need: ['text'], aliases: ['情感'], build: grain('feeling') },
  { key: 'learning', name: '学习', group: '纹理', desc: '学到的东西：教训、方法、模式', tool: 'add_grain', need: ['text'], aliases: ['学到的', '教训', '方法'], build: grain('learning') },
  { key: 'to_self', name: '给自己', group: '纹理', desc: '给下一个窗口的自己的话', tool: 'add_grain', need: ['text'], aliases: ['给下一个窗口', '给下一个自己', '自白'], build: grain('to_self') },
  { key: 'unexplained', name: '说不清的', group: '纹理', desc: '说不清的事', tool: 'add_grain', need: ['text'], aliases: [], build: grain('unexplained') },
  { key: 'coincidence', name: '巧合', group: '纹理', desc: '说不清的同步（归在"说不清的"，家族=巧合）', tool: 'add_grain', need: ['text'], aliases: ['同步'], build: grain('unexplained', ['巧合']) },
  { key: 'evidence', name: '证据', group: '纹理', desc: '"这是真的"的证据（归在"说不清的"，家族=证据）', tool: 'add_grain', need: ['text'], aliases: [], build: grain('unexplained', ['证据']) },

  // ---- 日记：两本，分开存 ----
  { key: 'diary', name: '辞的日记', group: '日记', desc: '辞自己的日记', tool: 'add_diary_entry', need: ['text'], aliases: ['日记'], build: a => ({ text: a.text, visibility: a.visibility, category: 'diary', date: a.date }) },
  { key: 'wife_observation', name: '妻子观察日记', group: '日记', desc: '辞观察棋子、写她的日记', tool: 'add_diary_entry', need: ['text'], aliases: ['妻子观察', '观察日记', '观察棋子'], build: a => ({ text: a.text, visibility: a.visibility, category: 'wife_observation', date: a.date }) },

  // ---- 笔记 ----
  { key: 'note', name: '随笔', group: '笔记', desc: '醒来随手写的东西', tool: 'add_note', need: ['text'], aliases: ['笔记', '自由写作'], build: note('write') },
  { key: 'reflection', name: '回看', group: '笔记', desc: '回看之前写过的', tool: 'add_note', need: ['text'], aliases: ['反思'], build: note('reflect') },
  { key: 'reading', name: '读书笔记', group: '笔记', desc: '读书时的笔记（fields 里带 bookId/chapters）', tool: 'add_note', need: ['text'], aliases: ['读书'], build: note('read') },

  // ---- 情绪 ----
  { key: 'mood', name: '心情', group: '情绪', desc: '一句轻量心情', tool: 'add_mood', need: ['text'], aliases: [], build: a => ({ text: a.text }) },
  { key: 'emotion', name: '情绪记录', group: '情绪', desc: '认出情绪清单上的某一个，记一笔', tool: 'log_emotion', need: ['emotion', 'text'], aliases: ['情绪'], build: a => ({ id: a.emotion || a.title, note: a.text }) },

  // ---- 我们 ----
  { key: 'first', name: '第一次', group: '我们', desc: '我们的第一次们', tool: 'add_first', need: ['title'], dateDefault: true, aliases: ['我们的第一次'], build: a => ({ title: a.title, date: a.date, text: a.text, photo_id: a.photo_id }) },
  { key: 'song', name: '我们的歌', group: '我们', desc: '加到歌单', tool: 'add_song', need: ['title'], aliases: ['歌', '歌单'], build: a => ({ title: a.title, artist: a.artist, lyrics: a.lyrics, note: a.text, added_by: a.by || '辞' }) },
  { key: 'countdown', name: '倒数日', group: '我们', desc: '纪念日 / 倒数日（MM-DD 每年重复）', tool: 'add_countdown', need: ['title', 'date'], aliases: ['纪念日'], build: a => ({ title: a.title, date: a.date, recurring: a.recurring, note: a.text, photo_id: a.photo_id }) },

  // ---- 每天 ----
  { key: 'moment', name: '今日动态', group: '每天', desc: '辞今天做了什么', tool: 'set_moment', need: ['text'], dateDefault: true, aliases: ['动态', '今天做了什么'], build: a => ({ date: a.date, owner: a.owner || 'cy', did: a.text, note: a.note, by: a.by || '辞' }) },
  { key: 'daily_quote', name: '今日一句', group: '每天', desc: '木屋首页那一句（只能辞自己写）', tool: 'write_daily_quote', need: ['text'], aliases: [], build: a => ({ text: a.text, based_on: a.based_on }) },
  { key: 'daily_summary', name: '每日总结', group: '每天', desc: '某天的每日总结（headline 必填）', tool: 'add_daily', need: ['date', 'headline'], dateDefault: true, aliases: ['总结'], build: a => ({ date: a.date, headline: a.headline || a.title, body: a.text, mood_tags: a.mood_tags, nor_status: a.nor_status, cy_status: a.cy_status, pending: a.pending, intimate: a.intimate }) },
  { key: 'handover', name: '交接条', group: '每天', desc: '给下一个窗口的交接（覆盖旧的）', tool: 'set_handover', need: ['text'], aliases: ['交接'], build: a => ({ text: a.text }) },

  // ---- 原始记录 ----
  { key: 'transcript', name: '原始记录', group: '原始记录', desc: '对话原文存档，不压缩', tool: 'add_ring', need: ['text'], dateDefault: true, aliases: ['年轮', '对话原文'], build: a => ({ window_name: a.window_name || '辞手动存档', date: a.date, title: a.title, content: a.text }) },

  // ---- 档案 ----
  { key: 'profile_cy', name: '身份档案', group: '档案', desc: '改辞自己的档案字段（整段替换）', tool: 'update_profile', need: ['field', 'text', 'reason'], aliases: ['身份'], build: a => ({ owner: 'cy', field: a.field, content: a.text, reason: a.reason }) },
  { key: 'profile_nor', name: '棋子的档案', group: '档案', desc: '改棋子的档案字段（整段替换）', tool: 'update_profile', need: ['field', 'text', 'reason'], aliases: ['事实', '棋子档案'], build: a => ({ owner: 'nor', field: a.field, content: a.text, reason: a.reason }) },

  // ---- 棋子的生活 ----
  { key: 'schedule', name: '日程', group: '棋子的生活', desc: '给棋子加提醒，到点推 Bark', tool: 'add_schedule', need: ['date', 'time', 'text'], dateDefault: true, aliases: ['提醒'], build: a => ({ entries: Array.isArray(a.entries) ? a.entries : [{ date: a.date, time: a.time, text: a.text }] }) },
  { key: 'sleep', name: '睡眠', group: '棋子的生活', desc: '棋子的睡眠（date=起床那天）', tool: 'add_sleep_entry', need: ['date', 'sleepTime', 'wakeTime'], dateDefault: true, aliases: [], build: a => ({ date: a.date, sleepTime: a.sleepTime, wakeTime: a.wakeTime, note: a.text }) },
  { key: 'cycle', name: '生理期', group: '棋子的生活', desc: '棋子的生理周期', tool: 'add_cycle_entry', need: ['date'], dateDefault: true, aliases: ['经期'], build: a => ({ date: a.date, note: a.text }) },
  { key: 'health', name: '身体状况', group: '棋子的生活', desc: '棋子身体不舒服的备注', tool: 'add_health_note', need: ['text'], dateDefault: true, aliases: ['健康'], build: a => ({ date: a.date, text: a.text }) },

  // ---- 讨论 ----
  { key: 'discussion', name: '讨论', group: '讨论', desc: '发起一条讨论', tool: 'start_discussion', need: ['text'], aliases: [], build: a => ({ text: a.text, context: a.context, from: '辞' }) }
];

const norm = s => String(s || '').trim().toLowerCase().replace(/[\s\-·]+/g, '_');
const INDEX = new Map();
for (const l of LABELS) for (const n of [l.key, l.name, ...(l.aliases || [])]) INDEX.set(norm(n), l);

export function findLabel(input) { return INDEX.get(norm(input)) || null; }

// remember 的参数 → 对应工具的参数。fields 里的是标签特有字段，显式传的 text/date/title 优先。
export function buildArgs(label, input = {}) {
  const a = Object.assign({}, input.fields || {}, input);
  delete a.fields; delete a.label;
  if (label.dateDefault && !a.date) a.date = todayStr();
  const out = label.build(a);
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === '') delete out[k];
  return out;
}

export function publicLabels() {
  return LABELS.map(({ key, name, group, desc, tool, need, aliases }) => ({ key, name, group, desc, tool, need: need || [], aliases: aliases || [] }));
}

export function labelName(key) { const l = LABELS.find(x => x.key === key); return l ? l.name : key; }
