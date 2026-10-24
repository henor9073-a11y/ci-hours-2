import * as chat from './chat.js';
import * as rings from './rings.js';
import * as nursery from './nursery.js';
import { localISO } from './common.js';

// main 是成年人主聊天的唯一默认时间线：木屋 + Claude，明确不含婴儿房。
// all 只留给显式的全库诊断；摘要、召回、换窗和导出不应默认用 all。
const SOURCES = ['main', 'all', 'muwu', 'claude', 'nursery'];

function sourceOf(value) {
  const source = String(value || 'main').toLowerCase();
  return SOURCES.includes(source) ? source : 'main';
}

function includesSource(source, kind) {
  if (source === 'all') return true;
  if (source === 'main') return kind === 'muwu' || kind === 'claude';
  return source === kind;
}

function textOfChat(m) {
  if (m.type === 'voice') return m.transcript || '语音消息';
  if (m.type === 'image') return m.content || (m.sticker ? '表情包' : '图片');
  if (m.type === 'pat') return chat.patText(m);
  return String(m.content || '');
}

function messageTime(value) {
  const match = String(value || '').match(/T(\d{2}:\d{2})/);
  return match ? match[1] : '';
}

function claudeText(message) {
  return (message.parts || []).filter(part => part.type === 'text').map(part => part.content).join('\n').trim();
}

function claudeMessages(date) {
  const dayData = rings.dayConversation(date);
  const messages = [];
  for (const ring of dayData.rings || []) {
    if (ring.preamble && !ring.continued) {
      messages.push({
        id: `claude:${ring.id}:preamble`, source: 'claude', sender: 'system', type: 'system',
        date, time: '', at: `${date}T00:00:00`, text: ring.preamble,
        window_name: ring.window_name || '', title: ring.title || '', ring_id: ring.id
      });
    }
    for (let index = 0; index < (ring.messages || []).length; index++) {
      const message = ring.messages[index];
      const text = claudeText(message);
      if (!text) continue;
      const time = message.time || '';
      messages.push({
        id: `claude:${ring.id}:${index}`, source: 'claude', sender: message.speaker,
        type: 'text', date, time, at: `${date}T${time || '12:00'}:00`, text,
        window_name: ring.window_name || '', title: ring.title || '',
        ring_id: ring.id, message_index: index
      });
    }
    if (ring.document) {
      messages.push({
        id: `claude:${ring.id}:document`, source: 'claude', sender: 'system', type: 'system',
        date, time: '', at: `${date}T12:00:00`, text: ring.document,
        window_name: ring.window_name || '', title: ring.title || '', ring_id: ring.id
      });
    }
  }
  return messages;
}

function muwuMessages(date) {
  return chat.historyDay(date).map(m => ({
    id: `muwu:${m.id}`, source: 'muwu', sender: m.sender, type: m.type,
    date, time: messageTime(m.at), at: m.at || `${date}T12:00:00`, text: textOfChat(m),
    original_id: m.id, quote: m.quote || null, window_name: '木屋'
  }));
}

function nurseryMessages(date) {
  return nursery.historyDay(date, 'nor').map(m => ({
    id: `nursery:${m.id}`, source: 'nursery', sender: m.sender, type: m.type,
    date, time: messageTime(m.at), at: m.at || `${date}T12:00:00`, text: String(m.content || ''),
    room: m.room, original_id: m.id, window_name: '婴儿房'
  }));
}

function dateIndex(source) {
  const muwu = chat.historyDates();
  const claude = rings.chatDates();
  const baby = nursery.historyDates('nor');
  const keys = new Set([
    ...(includesSource(source, 'muwu') ? Object.keys(muwu.dates || {}) : []),
    ...(includesSource(source, 'claude') ? Object.keys(claude.dates || {}) : []),
    ...(includesSource(source, 'nursery') ? Object.keys(baby || {}) : [])
  ]);
  return [...keys].sort();
}

export function dates({ source = 'main' } = {}) {
  source = sourceOf(source);
  const muwu = chat.historyDates();
  const claude = rings.chatDates();
  const baby = nursery.historyDates('nor');
  const keys = dateIndex(source);
  const out = {};
  for (const date of keys) {
    out[date] = {
      muwu: includesSource(source, 'muwu') ? Number(muwu.dates?.[date] || 0) : 0,
      claude: includesSource(source, 'claude') ? Number(claude.dates?.[date]?.count || 0) : 0,
      nursery: includesSource(source, 'nursery') ? Number(baby?.[date] || 0) : 0
    };
  }
  return { source, excludes: source === 'main' ? ['nursery'] : [], first: keys[0] || null, last: keys[keys.length - 1] || null, dates: out };
}

export function day({ date, source = 'main' } = {}) {
  source = sourceOf(source);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('date 要是 YYYY-MM-DD');
  let messages = [];
  if (includesSource(source, 'muwu')) messages.push(...muwuMessages(date));
  if (includesSource(source, 'claude')) messages.push(...claudeMessages(date));
  if (includesSource(source, 'nursery')) messages.push(...nurseryMessages(date));
  messages.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
  const keys = dateIndex(source);
  return {
    date, source, excludes: source === 'main' ? ['nursery'] : [], messages,
    prev_date: keys.filter(key => key < date).pop() || null,
    next_date: keys.find(key => key > date) || null
  };
}

function sourceLabel(message) {
  if (message.source === 'muwu') return '木屋';
  if (message.source === 'claude') return `Claude${message.window_name ? `·${message.window_name}` : ''}`;
  return '婴儿房';
}

function speakerLabel(sender) {
  return sender === 'nor' ? '棋子' : sender === 'cy' ? '辞' : sender === 'kuri' ? '小栗子' : '系统';
}

function visibleMainMessage(message) {
  return (message.sender === 'nor' || message.sender === 'cy') && String(message.text || '').trim();
}

function sourceSegments(messages) {
  const segments = [];
  for (const message of messages) {
    const key = `${message.source}:${message.window_name || ''}`;
    let segment = segments[segments.length - 1];
    if (!segment || segment.key !== key) {
      segment = { key, source: message.source, label: sourceLabel(message), window_name: message.window_name || '', from: message.at, to: message.at, count: 0 };
      segments.push(segment);
    }
    segment.to = message.at;
    segment.count++;
  }
  return segments.map(({ key, ...segment }) => segment);
}

function cursorOf(messages) {
  const cursor = { last_at: messages[messages.length - 1]?.at || null, last_muwu_message_id: null, last_claude_message_id: null };
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!cursor.last_muwu_message_id && message.source === 'muwu') cursor.last_muwu_message_id = message.original_id || message.id;
    if (!cursor.last_claude_message_id && message.source === 'claude') cursor.last_claude_message_id = message.id;
    if (cursor.last_muwu_message_id && cursor.last_claude_message_id) break;
  }
  return cursor;
}

function normalizedSearchHit(hit, fallbackSource) {
  const source = SOURCES.includes(hit?.source) && hit.source !== 'main' && hit.source !== 'all'
    ? hit.source : fallbackSource;
  const id = String(hit?.id || `${source}:unknown`);
  const at = String(hit?.at || '');
  const rawDate = String(hit?.date || at.slice(0, 10));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : localISO().slice(0, 10);
  return {
    ...hit,
    id,
    target_id: String(hit?.target_id || id),
    source,
    date,
    at: at || `${date}T12:00:00`,
    sender: String(hit?.sender || 'system'),
    before: String(hit?.before || ''),
    match: String(hit?.match || ''),
    after: String(hit?.after || '')
  };
}

function limitByChars(messages, maxChars) {
  if (!maxChars) return { messages, truncated: false };
  let total = 0;
  const kept = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const size = String(message.text || '').length + 80;
    if (kept.length && total + size > maxChars) break;
    kept.push(message); total += size;
  }
  kept.reverse();
  return { messages: kept, truncated: kept.length < messages.length };
}

// 给换窗、每日总结、自动记忆和聊天导出的统一输入。这里是这些后台任务的默认入口。
export function mainContext({ hours = 22, recent_hours = 2, max_messages = 4000, max_chars = 500000, now_at } = {}) {
  const nowDate = now_at ? new Date(now_at) : new Date();
  if (Number.isNaN(nowDate.getTime())) throw new Error('now_at 不是有效时间');
  const totalHours = Math.max(1, Math.min(Number(hours) || 22, 24 * 31));
  const recentHours = Math.max(1, Math.min(Number(recent_hours) || 2, totalHours));
  const to = localISO(nowDate);
  const from = localISO(new Date(nowDate.getTime() - totalHours * 3600000));
  const recentFrom = localISO(new Date(nowDate.getTime() - recentHours * 3600000));
  const dateKeys = dateIndex('main').filter(date => date >= from.slice(0, 10) && date <= to.slice(0, 10));
  let messages = dateKeys.flatMap(date => day({ date, source: 'main' }).messages)
    .filter(visibleMainMessage)
    .filter(message => String(message.at).slice(0, 19) >= from.slice(0, 19) && String(message.at).slice(0, 19) <= to.slice(0, 19));
  messages.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
  const maxMessages = Math.max(1, Number(max_messages) || 4000);
  const messageTruncated = messages.length > maxMessages;
  if (messageTruncated) messages = messages.slice(-maxMessages);
  const limited = limitByChars(messages, Math.max(1000, Number(max_chars) || 500000));
  messages = limited.messages;
  const recentMessages = messages.filter(message => String(message.at).slice(0, 19) >= recentFrom.slice(0, 19));
  const counts = { muwu: 0, claude: 0 };
  for (const message of messages) counts[message.source] = (counts[message.source] || 0) + 1;
  return {
    source: 'main', includes: ['muwu', 'claude'], excludes: ['nursery'],
    purpose: ['window_handover', 'daily_summary', 'auto_memory', 'chat_export'],
    from, to, recent_from: recentFrom, hours: totalHours, recent_hours: recentHours,
    counts_by_source: counts, total: messages.length, truncated: limited.truncated || messageTruncated,
    source_segments: sourceSegments(messages), cursor: cursorOf(messages),
    messages, recent_messages: recentMessages,
    export_text: messages.map(message => `[${String(message.at).slice(0, 16).replace('T', ' ')}][${sourceLabel(message)}][${speakerLabel(message.sender)}] ${message.text}`).join('\n\n')
  };
}

export function exportDay({ date, source = 'main' } = {}) {
  const result = day({ date, source });
  const messages = result.messages.filter(message => message.sender !== 'system' && String(message.text || '').trim());
  const content = messages.map(message => `[${message.time || '时间未记'}][${sourceLabel(message)}][${speakerLabel(message.sender)}] ${message.text}`).join('\n\n');
  const counts = {};
  for (const message of messages) counts[message.source] = (counts[message.source] || 0) + 1;
  return {
    date, source: result.source, excludes: result.excludes, counts_by_source: counts,
    source_segments: sourceSegments(messages), cursor: cursorOf(messages), messages, content
  };
}

export function search({ query, source = 'main', limit = 80, skip = 0 } = {}) {
  const q = String(query || '').trim();
  source = sourceOf(source);
  if (!q) return { query: '', source, total: 0, hits: [] };
  const poolLimit = Math.min(1000, Math.max(1, Number(skip) + Number(limit)));
  const hits = [];
  let total = 0;
  if (includesSource(source, 'muwu')) {
    const found = chat.searchChat({ q, limit: poolLimit, skip: 0 });
    total += found.total || 0;
    for (const hit of found.hits || []) hits.push(normalizedSearchHit({
      id: `muwu:${hit.id}`, target_id: `muwu:${hit.id}`, source: 'muwu',
      date: hit.date || String(hit.at || '').slice(0, 10), at: hit.at || '',
      sender: hit.sender, before: hit.before, match: hit.match, after: hit.after
    }, 'muwu'));
  }
  if (includesSource(source, 'claude')) {
    const found = rings.searchRingOccurrences({ query: q, source_type: 'chat', perRing: poolLimit, limit: poolLimit, skip: 0, radius: 60 });
    total += found.total || 0;
    for (const hit of found.hits || []) hits.push(normalizedSearchHit({
      id: `claude:${hit.ring_id}:${hit.msg_index ?? 'document'}:${hit.offset}`,
      target_id: `claude:${hit.ring_id}:${hit.msg_index ?? 'document'}`, source: 'claude',
      date: hit.date, at: hit.date || '', sender: hit.speaker || 'system', time: hit.time || '',
      before: hit.before, match: hit.match, after: hit.after,
      window_name: hit.window_name || '', title: hit.title || ''
    }, 'claude'));
  }
  if (includesSource(source, 'nursery')) {
    const found = nursery.search({ q, viewer: 'nor', limit: poolLimit, skip: 0 });
    total += found.total || 0;
    for (const hit of found.hits || []) hits.push(normalizedSearchHit(hit, 'nursery'));
  }
  hits.sort((a, b) => String(b.at || b.date).localeCompare(String(a.at || a.date)));
  return { query: q, source, excludes: source === 'main' ? ['nursery'] : [], total, skip, shown: Math.min(limit, Math.max(0, hits.length - skip)), hits: hits.slice(skip, skip + limit) };
}
