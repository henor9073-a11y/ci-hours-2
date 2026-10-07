import { file, readJSON, writeJSON, newId, now, timezone } from './common.js';
import * as chat from './chat.js';

const STATE = file('call-state.json');
const HISTORY = file('call-history.json');
const EVENTS = file('call-events.json');
const SETTINGS = file('call-settings.json');

export const DEFAULT_SETTINGS = {
  allowIncoming: true, quietEnabled: false, quietStart: '23:30', quietEnd: '08:00',
  ringSeconds: 90, barkRepeats: 2, endPause: 'standard', subtitles: true,
  tokenMode: 'balanced',
  subtitleMode: 'three', interrupt: true, reconnect: true, saveTranscript: true,
  saveAudio: false, messagePush: true, callPush: true
};
const PAUSES = { fast: 800, standard: 1500, slow: 2500, very_slow: 4000 };
const activeStatus = s => ['ringing', 'active', 'reconnecting'].includes(s);
const clean = c => c && activeStatus(c.status) ? c : null;

export function getSettings() { return { ...DEFAULT_SETTINGS, ...readJSON(SETTINGS, {}) }; }
export function updateSettings(patch = {}) {
  const allowed = Object.keys(DEFAULT_SETTINGS), out = getSettings();
  for (const k of allowed) if (patch[k] !== undefined) out[k] = patch[k];
  if (!PAUSES[out.endPause]) out.endPause = 'standard';
  if (!['economy', 'balanced', 'low_latency'].includes(out.tokenMode)) out.tokenMode = 'balanced';
  out.ringSeconds = Math.max(30, Math.min(120, Number(out.ringSeconds) || 90));
  out.barkRepeats = Math.max(0, Math.min(2, Number(out.barkRepeats) || 0));
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
  const l = events(); l.push(e); writeJSON(EVENTS, l.slice(-1000)); return e;
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
export function getState({ since = '' } = {}) {
  const c = refresh();
  const list = c ? events().filter(e => e.call_id === c.id && (!since || Date.parse(e.at) > Date.parse(since))) : [];
  return { call: c, active: !!clean(c), events: list, settings: getSettings(), pause_ms: pauseMs() };
}
export function start(caller) {
  if (!['nor', 'cy'].includes(caller)) throw new Error('caller 必须是 nor/cy');
  const old = clean(refresh()); if (old) throw new Error('已经有一通电话正在进行');
  const s = getSettings();
  if (caller === 'cy' && (!s.allowIncoming || inQuietHours())) {
    const reason = !s.allowIncoming ? 'incoming_disabled' : 'quiet_hours';
    const c = { id: newId('call'), caller, status: 'blocked', reason, created_at: now(), ended_at: now(), ended_by: 'system' };
    const h = readJSON(HISTORY, []); h.push(c); writeJSON(HISTORY, h.slice(-200)); chat.sendCallRecord(c); return c;
  }
  const c = { id: newId('call'), caller, callee: caller === 'cy' ? 'nor' : 'cy', status: 'ringing', created_at: now(), ring_seconds: s.ringSeconds };
  saveState(c); emit(c.id, 'ringing', caller); return c;
}
export function action(actor, action) {
  const c = clean(refresh()); if (!c) throw new Error('现在没有进行中的电话');
  if (action === 'accept') { c.status = 'active'; c.accepted_at = now(); c.accepted_by = actor; saveState(c); emit(c.id, 'accepted', actor); return c; }
  if (action === 'reject') return finish(c, 'rejected', actor);
  if (action === 'hangup') return finish(c, 'ended', actor);
  if (action === 'reconnecting') { c.status = 'reconnecting'; saveState(c); emit(c.id, 'reconnecting', actor); return c; }
  if (action === 'reconnected') { c.status = 'active'; saveState(c); emit(c.id, 'reconnected', actor); return c; }
  throw new Error('未知通话操作');
}
export function say(speaker, text, source = 'voice') {
  const c = clean(refresh()); if (!c || c.status !== 'active') throw new Error('电话还没有接通');
  const value = String(text || '').trim(); if (!value) throw new Error('内容不能为空');
  return emit(c.id, 'utterance', speaker, { text: value, source });
}
export function pendingForCy() {
  // 结束后的 STATE 仍保留最后一通电话。不能在这里 clean 掉，否则 ended/rejected/missed
  // 刚写进去就再也取不到，GPD 会一直以为电话还没挂。
  const c = refresh(); if (!c) return { call: null, events: [] };
  return { call: c, events: events().filter(e => e.call_id === c.id && e.by !== 'cy' && !e.delivered_to_cy), settings: { tokenMode: getSettings().tokenMode } };
}
export function markDelivered(ids = []) {
  const set = new Set(ids), l = events(); let n = 0;
  for (const e of l) if (set.has(e.id) && !e.delivered_to_cy) { e.delivered_to_cy = true; n++; }
  if (n) writeJSON(EVENTS, l); return { ok: true, count: n };
}
export function history(limit = 50) { return readJSON(HISTORY, []).slice(-limit).reverse(); }
export function event(id) { return events().find(e => e.id === id) || null; }
