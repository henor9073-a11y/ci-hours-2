import { file, readJSON, writeJSON, newId, now, timezone, localISO } from './common.js';
import * as chat from './chat.js';

const STATE = file('call-state.json');
const HISTORY = file('call-history.json');
const EVENTS = file('call-events.json');
const SETTINGS = file('call-settings.json');
const FAVORITES = file('call-favorites.json');

export const DEFAULT_SETTINGS = {
  allowIncoming: true, quietEnabled: false, quietStart: '23:30', quietEnd: '08:00',
  ringSeconds: 90, barkRepeats: 2, endPause: 'standard', subtitles: true,
  tokenMode: 'balanced',
  subtitleMode: 'three', interrupt: true, reconnect: true, saveTranscript: true,
  saveAudio: false, messagePush: true, callPush: true,
  ambientEnabled: false
};
const PAUSES = { fast: 800, standard: 1500, slow: 2500, very_slow: 4000 };
const activeStatus = s => ['ringing', 'active', 'reconnecting'].includes(s);
const clean = c => c && activeStatus(c.status) ? c : null;
export function sessionRoutingEnabled() { return process.env.CALL_SESSION_ROUTING_V2 !== 'false'; }

function ownerFields(owner = {}, initiatedVia = '') {
  const sessionId = String(owner.session_id || '').trim();
  return {
    owner_session_id: sessionId || null,
    owner_window_name: String(owner.window_name || '').trim() || null,
    owner_model: String(owner.model || '').trim() || null,
    owner_model_label: String(owner.model_label || '').trim() || null,
    owner_kind: owner.is_primary ? 'primary' : sessionId ? 'secondary' : 'legacy',
    route_version: sessionRoutingEnabled() ? 2 : 1,
    initiated_via: initiatedVia || null
  };
}

function assertOwner(c, sessionId) {
  if (!sessionRoutingEnabled() || !c?.owner_session_id) return;
  const requested = String(sessionId || '').trim();
  if (!requested) throw new Error('这个窗口缺少通话身份，不能操作这通电话');
  if (requested !== c.owner_session_id) throw new Error('这通电话属于另一个窗口，不能从这里接管');
}

export function getSettings() { return { ...DEFAULT_SETTINGS, ...readJSON(SETTINGS, {}) }; }
export function updateSettings(patch = {}) {
  const allowed = Object.keys(DEFAULT_SETTINGS), out = getSettings();
  for (const k of allowed) if (patch[k] !== undefined) out[k] = patch[k];
  if (!PAUSES[out.endPause]) out.endPause = 'standard';
  if (!['economy', 'balanced', 'low_latency'].includes(out.tokenMode)) out.tokenMode = 'balanced';
  out.ringSeconds = Math.max(30, Math.min(120, Number(out.ringSeconds) || 90));
  out.barkRepeats = Math.max(0, Math.min(2, Number(out.barkRepeats) || 0));
  out.ambientEnabled = out.ambientEnabled === true;
  writeJSON(SETTINGS, out); return out;
}
export function pauseMs() { return PAUSES[getSettings().endPause] || 1500; }
export function inQuietHours(date = new Date()) {
  const s = getSettings(); if (!s.quietEnabled) return false;
  const hm = date.toLocaleTimeString('en-GB', { timeZone: timezone(), hour: '2-digit', minute: '2-digit', hour12: false });
  return s.quietStart <= s.quietEnd ? hm >= s.quietStart && hm < s.quietEnd : hm >= s.quietStart || hm < s.quietEnd;
}
function events() { return readJSON(EVENTS, []); }
function emit(callId, type, by, data = {}) {
  const e = { id: newId('ce'), call_id: callId, type, by, at: now(), delivered_to_cy: by === 'cy', ...data };
  const l = events(); l.push(e);
  // 一通很长的电话不能因为全局 1000 条轮转而从开头开始掉转写。当前 call 的
  // 事件完整保留到挂断并写入 HISTORY；其他旧 call 仍只留最近 1000 条作投递兼容。
  const current = l.filter(item => item.call_id === callId);
  const older = l.filter(item => item.call_id !== callId).slice(-1000);
  writeJSON(EVENTS, [...older, ...current]); return e;
}
function saveState(c) { writeJSON(STATE, c || null); return c; }
function finish(c, status, by) {
  c.status = status; c.ended_at = now(); c.ended_by = by;
  const h = readJSON(HISTORY, []); h.push({ ...c, events: events().filter(e => e.call_id === c.id) });
  writeJSON(HISTORY, h.slice(-200)); saveState(c); emit(c.id, status, by); chat.sendCallRecord(c); return c;
}
function refresh() {
  const c = readJSON(STATE, null); if (!c || !activeStatus(c.status)) return c;
  if (c.status === 'ringing' && Date.now() - Date.parse(c.created_at) > (c.ring_seconds || 90) * 1000) return finish(c, 'missed', 'system');
  return c;
}
export function getState({ since = '', sessionId = '' } = {}) {
  const c = refresh();
  if (sessionId && sessionRoutingEnabled() && c?.owner_session_id && c.owner_session_id !== sessionId) {
    return { call: null, active: false, events: [], settings: getSettings(), pause_ms: pauseMs(), blocked: true, reason: 'not_call_owner' };
  }
  const list = c ? events().filter(e => e.call_id === c.id && (!since || Date.parse(e.at) > Date.parse(since))) : [];
  return { call: c, active: !!clean(c), events: list, settings: getSettings(), pause_ms: pauseMs() };
}
export function start(caller, { owner = {}, initiatedVia = '' } = {}) {
  if (!['nor', 'cy'].includes(caller)) throw new Error('caller 必须是 nor/cy');
  const old = clean(refresh()); if (old) throw new Error('已经有一通电话正在进行');
  const s = getSettings();
  if (caller === 'cy' && (!s.allowIncoming || inQuietHours())) {
    const reason = !s.allowIncoming ? 'incoming_disabled' : 'quiet_hours';
    const c = { id: newId('call'), caller, status: 'blocked', reason, created_at: now(), ended_at: now(), ended_by: 'system', ...ownerFields(owner, initiatedVia) };
    const h = readJSON(HISTORY, []); h.push(c); writeJSON(HISTORY, h.slice(-200)); chat.sendCallRecord(c); return c;
  }
  if (sessionRoutingEnabled() && caller === 'cy' && !owner.session_id) throw new Error('当前窗口没有可验证的 session，不能发起通话');
  const c = { id: newId('call'), caller, callee: caller === 'cy' ? 'nor' : 'cy', status: 'ringing', created_at: now(), ring_seconds: s.ringSeconds, ...ownerFields(owner, initiatedVia) };
  saveState(c); emit(c.id, 'ringing', caller); return c;
}
export function action(actor, action, { sessionId = '' } = {}) {
  const c = clean(refresh()); if (!c) throw new Error('现在没有进行中的电话');
  if (actor === 'cy') assertOwner(c, sessionId);
  if (action === 'accept') { c.status = 'active'; c.accepted_at = now(); c.accepted_by = actor; saveState(c); emit(c.id, 'accepted', actor); return c; }
  if (action === 'reject') return finish(c, 'rejected', actor);
  if (action === 'hangup') return finish(c, 'ended', actor);
  if (action === 'reconnecting') { c.status = 'reconnecting'; saveState(c); emit(c.id, 'reconnecting', actor); return c; }
  if (action === 'reconnected') { c.status = 'active'; saveState(c); emit(c.id, 'reconnected', actor); return c; }
  throw new Error('未知通话操作');
}
export function requireActive(callId = '') {
  const c = clean(refresh());
  if (!c || c.status !== 'active' || (callId && c.id !== callId)) {
    const error = new Error('这段输入所属的电话已经结束'); error.status = 409; throw error;
  }
  return c;
}
export function say(speaker, text, source = 'voice', { sessionId = '', callId = '', segmentId = '' } = {}) {
  const c = requireActive(callId);
  if (speaker === 'cy') assertOwner(c, sessionId);
  if (!['nor', 'cy'].includes(speaker)) throw new Error('speaker 必须是 nor/cy');
  if (segmentId) {
    const previous = events().find(e => e.call_id === c.id && e.by === speaker && e.segment_id === segmentId);
    if (previous) return previous;
  }
  const value = String(text || '').trim(); if (!value) throw new Error('内容不能为空');
  return emit(c.id, 'utterance', speaker, { text: value, source,
    input_channel: 'muwu_call', owner_session_id: c.owner_session_id,
    ...(segmentId ? { segment_id: String(segmentId).slice(0, 100) } : {}),
    ...(speaker === 'nor' && ['voice', 'device_speech'].includes(source) ? { analysis_status: 'pending' } : {}) });
}

// Observations remain system events; neither ambient sound nor an inference is a user utterance.
export function ambient(callId, { sounds = [], observed_at = '' } = {}) {
  const c = requireActive(callId);
  if (!getSettings().ambientEnabled) return { ignored: true, reason: 'disabled' };
  const labels = { music: '背景里可能有音乐', water: '听到持续水声', dog: '听到像是狗叫的声音',
    cat: '听到像是猫叫的声音', traffic: '背景里可能有车辆声', typing: '听到像是键盘敲击的声音',
    rain: '背景里可能有雨声', door: '听到像是门的声音' };
  const accepted = sounds.filter(s => Object.hasOwn(labels, s?.label) && Number(s.confidence) >= 0.75)
    .slice(0, 3).map(s => ({ label: s.label, confidence: Math.min(1, Number(s.confidence)) }));
  if (!accepted.length) return { ignored: true, reason: 'uncertain' };
  const key = accepted.map(s => s.label).sort().join(',');
  const previous = events().filter(e => e.call_id === c.id && e.type === 'ambient').at(-1);
  const elapsed = previous ? Date.now() - Date.parse(previous.at) : Infinity;
  if (elapsed < 15_000 || (previous?.sound_key === key && elapsed < 120_000)) return { ignored: true, reason: 'unchanged' };
  return emit(c.id, 'ambient', 'system', { source: 'environment_audio', input_channel: 'muwu_system',
    owner_session_id: c.owner_session_id, observed_at: String(observed_at).slice(0, 40),
    sound_key: key, sounds: accepted, text: accepted.map(s => labels[s.label]).join('；') });
}

function updateEvent(id, mutate) {
  const l = events(), item = l.find(e => e.id === id);
  // Finished calls may already have left the rotating event log.
  const h = readJSON(HISTORY, []);
  const archived = h.flatMap(c => c.events || []).find(e => e.id === id);
  const target = item || archived;
  if (!target || target.type !== 'utterance' || target.by !== 'nor') return null;
  mutate(target);
  if (item) writeJSON(EVENTS, l);
  if (archived) { Object.assign(archived, target); writeJSON(HISTORY, h); }
  return target;
}
export function setVoiceTone(id, raw = {}) {
  const result = updateEvent(id, e => {
    const status = ['ready', 'neutral', 'uncertain', 'too_short', 'failed'].includes(raw.status) ? raw.status : 'ready';
    e.voice_tone = { tone: String(raw.tone || '').slice(0, 120), emotion: String(raw.emotion || '').slice(0, 60),
      tags: (Array.isArray(raw.tags) ? raw.tags : []).map(t => String(t).slice(0, 20)).slice(0, 3),
      hint: String(raw.hint || '').slice(0, 120), confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)), at: now() };
    e.analysis_status = status;
  });
  // The observation belongs to the original utterance.  Emitting a second
  // system event woke Claude for the same sentence twice, wasting a full turn
  // and sometimes delaying the next live reply.  The bridge may enrich the
  // original delivery when analysis is already ready; otherwise this metadata
  // remains available in call history without another prompt.
  return result;
}
export function setVoiceLabel(id, raw = {}) {
  const event = updateEvent(id, e => {
    e.voice_label = { tags: [...new Set((Array.isArray(raw.tags) ? raw.tags : []).map(t => String(t).trim().slice(0, 20)).filter(Boolean))].slice(0, 12),
      skip: raw.skip === true, note: String(raw.note || '').slice(0, 300), at: now() };
  });
  if (!event) return null;
  const c = refresh();
  // A late correction is tied to the original call; never wake a new call or take over its owner.
  if (c?.id === event.call_id && c.status === 'active') emit(c.id, 'emotion_correction', 'system', {
    input_channel: 'muwu_system', source: 'user_correction', related_event_id: id,
    owner_session_id: c.owner_session_id,
    text: event.voice_label.skip ? 'Nor 标记了这段不是她在说话，不应据此推断她的情绪。'
      : `Nor 亲自更正了这句当时的感受：${event.voice_label.tags.join('、') || '没有明显情绪'}。${event.voice_label.note ? `她的补充：${event.voice_label.note}。` : ''}这份人工更正优先于机器推测。` });
  return event;
}
export function voiceToneItems() {
  return transcriptEvents().filter(e => e.by === 'nor' && ['voice', 'device_speech'].includes(e.source))
    .slice(-300).reverse().map(e => ({ ...e, transcript: e.text }));
}
export function favorite({ event_ids = [], title = '' } = {}) {
  const all = transcriptEvents(), ids = new Set(event_ids);
  const chosen = all.filter(e => ids.has(e.id));
  if (!chosen.length || chosen.length !== ids.size || chosen.length > 30) throw new Error('请选择 1–30 句仍在记录中的通话');
  if (new Set(chosen.map(e => e.call_id)).size !== 1) throw new Error('一次只能收藏同一通电话的片段');
  const list = readJSON(FAVORITES, []);
  const item = { id: newId('cf'), call_id: chosen[0].call_id, title: String(title || '').slice(0, 100),
    at: now(), events: chosen.map(e => ({ id: e.id, call_id: e.call_id, type: e.type, source: e.source, by: e.by, text: e.text, at: e.at })), audio: [] };
  list.push(item); writeJSON(FAVORITES, list); return item;
}
export function favorites() { return readJSON(FAVORITES, []).reverse(); }
export function deleteFavorite(id) { writeJSON(FAVORITES, readJSON(FAVORITES, []).filter(x => x.id !== id)); }
export function pendingForCy(sessionId = '') {
  // 结束后的 STATE 仍保留最后一通电话。不能在这里 clean 掉，否则 ended/rejected/missed
  // 刚写进去就再也取不到，GPD 会一直以为电话还没挂。
  const c = refresh(); if (!c) return { call: null, events: [] };
  if (sessionRoutingEnabled() && c.owner_session_id !== String(sessionId || '').trim()) {
    return { call: null, events: [], blocked: true, reason: 'not_call_owner' };
  }
  return { call: c, events: events().filter(e => e.call_id === c.id && e.by !== 'cy' && !e.delivered_to_cy), settings: { tokenMode: getSettings().tokenMode } };
}
export function markDelivered(ids = [], sessionId = '') {
  const c = refresh();
  if (sessionRoutingEnabled()) assertOwner(c, sessionId);
  const set = new Set(ids), l = events(); let n = 0;
  for (const e of l) if (set.has(e.id) && e.call_id === c?.id && !e.delivered_to_cy) { e.delivered_to_cy = true; n++; }
  if (n) writeJSON(EVENTS, l); return { ok: true, count: n };
}
export function history(limit = 50) { return readJSON(HISTORY, []).slice(-limit).reverse(); }
export function event(id) { return events().find(e => e.id === id) || null; }

// 通话语句本来一直保存在 call-history / call-events 里，只是以前没有进入
// “成年人主聊天”时间线。这里给历史、换窗、每日总结和导出提供一个稳定的
// 只读视图：只暴露文字转写，不暴露临时音频，也不把响铃/接听等状态伪装成对话。
function transcriptEvents() {
  const byId = new Map();
  for (const call of readJSON(HISTORY, [])) {
    for (const raw of (Array.isArray(call?.events) ? call.events : [])) {
      if (!raw?.id) continue;
      byId.set(raw.id, { ...raw, call_status: call.status || '', call_ended_at: call.ended_at || '',
        owner_session_id: call.owner_session_id || '', owner_window_name: call.owner_window_name || '',
        owner_model: call.owner_model || '', owner_model_label: call.owner_model_label || '' });
    }
  }
  // 当前通话尚未结束时还不在 HISTORY；EVENTS 也保留最近事件。后写入只补齐
  // 最新投递字段，不会制造第二条语句。
  for (const raw of events()) {
    if (!raw?.id) continue;
    byId.set(raw.id, { ...(byId.get(raw.id) || {}), ...raw });
  }
  return [...byId.values()]
    .filter(item => item.type === 'utterance' && item.voice_label?.skip !== true && ['nor', 'cy'].includes(item.by) && String(item.text || '').trim())
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || String(a.id).localeCompare(String(b.id)));
}

function eventDate(value) {
  const parsed = new Date(value || '');
  return Number.isNaN(parsed.getTime()) ? String(value || '').slice(0, 10) : localISO(parsed).slice(0, 10);
}

export function transcriptDates() {
  const dates = {};
  for (const item of transcriptEvents()) {
    const date = eventDate(item.at);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    dates[date] = (dates[date] || 0) + 1;
  }
  const keys = Object.keys(dates).sort();
  return { first: keys[0] || null, last: keys[keys.length - 1] || null, dates };
}

export function transcriptDay(date) {
  return transcriptEvents()
    .filter(item => eventDate(item.at) === date)
    .map(item => ({
      id: item.id, call_id: item.call_id, sender: item.by, text: String(item.text || '').trim(),
      at: item.at, date, input_source: item.source || 'voice', call_status: item.call_status || '',
      owner_session_id: item.owner_session_id || '', owner_window_name: item.owner_window_name || '',
      owner_model: item.owner_model || '', owner_model_label: item.owner_model_label || ''
    }));
}

export function searchTranscripts({ q, limit = 60, skip = 0 } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return { query: '', total: 0, hits: [] };
  const matched = [];
  for (const item of transcriptEvents().reverse()) {
    const text = String(item.text || '');
    const index = text.toLowerCase().indexOf(needle);
    if (index >= 0) matched.push({ item, text, index });
  }
  const hits = matched.slice(skip, skip + limit).map(({ item, text, index }) => {
    const start = Math.max(0, index - 24), end = Math.min(text.length, index + needle.length + 60);
    return {
      id: item.id, call_id: item.call_id, sender: item.by, at: item.at, date: eventDate(item.at),
      before: (start > 0 ? '…' : '') + text.slice(start, index),
      match: text.slice(index, index + needle.length),
      after: text.slice(index + needle.length, end) + (end < text.length ? '…' : '')
    };
  });
  return { query: needle, total: matched.length, skip, shown: hits.length, hits };
}
