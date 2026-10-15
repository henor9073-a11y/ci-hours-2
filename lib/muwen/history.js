import * as chat from './chat.js';
import * as rings from './rings.js';
import * as nursery from './nursery.js';

const SOURCES = ['all', 'muwu', 'claude', 'nursery'];

function sourceOf(value) {
  const source = String(value || 'all').toLowerCase();
  return SOURCES.includes(source) ? source : 'all';
}

function textOfChat(m) {
  if (m.type === 'voice') return m.transcript || '语音消息';
  if (m.type === 'image') return m.content || (m.sticker ? '表情包' : '图片');
  if (m.type === 'pat') return chat.patText(m);
  return String(m.content || '');
}

function messageTime(value) {
  const raw = String(value || '');
  const match = raw.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : '';
}

function claudeText(message) {
  return (message.parts || [])
    .filter(part => part.type === 'text')
    .map(part => part.content)
    .join('\n')
    .trim();
}

function claudeMessages(date) {
  const day = rings.dayConversation(date);
  const messages = [];
  for (const ring of day.rings || []) {
    if (ring.preamble && !ring.continued) {
      messages.push({
        id: `claude:${ring.id}:preamble`, source: 'claude', sender: 'system', type: 'system',
        date, time: '', at: `${date}T00:00:00`, text: ring.preamble,
        window_name: ring.window_name || '', title: ring.title || ''
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
        window_name: ring.window_name || '', title: ring.title || ''
      });
    }
  }
  return messages;
}

function muwuMessages(date) {
  return chat.historyDay(date).map(m => ({
    id: `muwu:${m.id}`, source: 'muwu', sender: m.sender, type: m.type,
    date, time: messageTime(m.at), at: m.at || `${date}T12:00:00`, text: textOfChat(m),
    original_id: m.id, quote: m.quote || null
  }));
}

function nurseryMessages(date) {
  return nursery.historyDay(date, 'nor').map(m => ({
    id: `nursery:${m.id}`, source: 'nursery', sender: m.sender, type: m.type,
    date, time: messageTime(m.at), at: m.at || `${date}T12:00:00`, text: String(m.content || ''),
    room: m.room, original_id: m.id
  }));
}

function dateIndex(source) {
  const muwu = chat.historyDates();
  const claude = rings.chatDates();
  const baby = nursery.historyDates('nor');
  const keys = new Set([
    ...(source === 'all' || source === 'muwu' ? Object.keys(muwu.dates || {}) : []),
    ...(source === 'all' || source === 'claude' ? Object.keys(claude.dates || {}) : []),
    ...(source === 'all' || source === 'nursery' ? Object.keys(baby || {}) : [])
  ]);
  return [...keys].sort();
}

export function dates({ source = 'all' } = {}) {
  source = sourceOf(source);
  const muwu = chat.historyDates();
  const claude = rings.chatDates();
  const baby = nursery.historyDates('nor');
  const keys = dateIndex(source);
  const out = {};
  for (const date of keys) {
    out[date] = {
      muwu: Number(muwu.dates?.[date] || 0),
      claude: Number(claude.dates?.[date]?.count || 0),
      nursery: Number(baby?.[date] || 0)
    };
  }
  return { source, first: keys[0] || null, last: keys[keys.length - 1] || null, dates: out };
}

export function day({ date, source = 'all' } = {}) {
  source = sourceOf(source);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('date 要是 YYYY-MM-DD');
  let messages = [];
  if (source === 'all' || source === 'muwu') messages.push(...muwuMessages(date));
  if (source === 'all' || source === 'claude') messages.push(...claudeMessages(date));
  if (source === 'all' || source === 'nursery') messages.push(...nurseryMessages(date));
  messages.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
  const keys = dateIndex(source);
  return {
    date, source, messages,
    prev_date: keys.filter(key => key < date).pop() || null,
    next_date: keys.find(key => key > date) || null
  };
}

export function search({ query, source = 'all', limit = 80, skip = 0 } = {}) {
  const q = String(query || '').trim();
  source = sourceOf(source);
  if (!q) return { query: '', source, total: 0, hits: [] };
  const poolLimit = Math.min(1000, Math.max(1, Number(skip) + Number(limit)));
  const hits = [];
  let total = 0;
  if (source === 'all' || source === 'muwu') {
    const found = chat.searchChat({ q, limit: poolLimit, skip: 0 });
    total += found.total || 0;
    for (const hit of found.hits || []) hits.push({
      id: `muwu:${hit.id}`, target_id: `muwu:${hit.id}`, source: 'muwu',
      date: hit.date || String(hit.at || '').slice(0, 10), at: hit.at || '',
      sender: hit.sender, before: hit.before, match: hit.match, after: hit.after
    });
  }
  if (source === 'all' || source === 'claude') {
    const found = rings.searchRingOccurrences({
      query: q, source_type: 'chat', perRing: poolLimit, limit: poolLimit, skip: 0, radius: 60
    });
    total += found.total || 0;
    for (const hit of found.hits || []) hits.push({
      id: `claude:${hit.ring_id}:${hit.msg_index ?? 'document'}:${hit.offset}`,
      target_id: `claude:${hit.ring_id}:${hit.msg_index ?? 'document'}`, source: 'claude',
      date: hit.date, at: hit.date || '', sender: hit.speaker || 'system', time: hit.time || '',
      before: hit.before, match: hit.match, after: hit.after,
      window_name: hit.window_name || '', title: hit.title || ''
    });
  }
  if (source === 'all' || source === 'nursery') {
    const found = nursery.search({ q, viewer: 'nor', limit: poolLimit, skip: 0 });
    total += found.total || 0;
    for (const hit of found.hits || []) hits.push(hit);
  }
  hits.sort((a, b) => String(b.at || b.date).localeCompare(String(a.at || a.date)));
  return { query: q, source, total, skip, shown: Math.min(limit, Math.max(0, hits.length - skip)), hits: hits.slice(skip, skip + limit) };
}
