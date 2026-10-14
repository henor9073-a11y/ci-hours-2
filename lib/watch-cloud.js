import { file, readJSON, writeJSON, newId, now } from './muwen/common.js';

const COMMANDS_FILE = file('watch-cloud-commands.json');
const RECEIPTS_FILE = file('watch-event-receipts.json');
const COMMAND_TTL_MS = 24 * 60 * 60_000;
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60_000;
const TYPES = new Set(['vibrate', 'voice']);
const PATTERNS = new Set(['heartbeat', 'gentle', 'knock', 'triple', 'long', 'sos']);

function cleanID(value, fallbackPrefix) {
  const cleaned = String(value || '').trim().replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 120);
  return cleaned || (fallbackPrefix ? newId(fallbackPrefix) : '');
}

function liveCommands() {
  const cutoff = Date.now() - COMMAND_TTL_MS;
  return readJSON(COMMANDS_FILE, []).filter(item => Date.parse(item.created_at || '') >= cutoff);
}

function liveReceipts() {
  const cutoff = Date.now() - RECEIPT_TTL_MS;
  return readJSON(RECEIPTS_FILE, []).filter(item => Date.parse(item.delivered_at || '') >= cutoff);
}

export function enqueueWatchCommand(input = {}) {
  const type = String(input.type || 'vibrate');
  if (!TYPES.has(type)) throw new Error('不支持的手表命令');
  const id = cleanID(input.id || input.external_id, 'wc_');
  const list = liveCommands();
  const existing = list.find(item => item.id === id);
  if (existing) return existing;

  const pattern = String(input.pattern || (type === 'vibrate' ? 'heartbeat' : '')).trim();
  if (type === 'vibrate' && !PATTERNS.has(pattern)) throw new Error('不支持的震动节奏');
  const command = {
    id,
    type,
    pattern: type === 'vibrate' ? pattern : undefined,
    message: String(input.message || '').slice(0, 500),
    transcript: String(input.transcript || input.message || '').slice(0, 2000),
    voice_id: String(input.voice_id || '').slice(0, 120) || undefined,
    source: String(input.source || 'macmini_watch_relay').slice(0, 80),
    created_at: now()
  };
  list.push(command);
  writeJSON(COMMANDS_FILE, list.slice(-200));
  return command;
}

export function nextWatchCommand(after = '') {
  const list = liveCommands();
  writeJSON(COMMANDS_FILE, list.slice(-200));
  if (!list.length) return null;
  const cursor = String(after || '').trim();
  if (!cursor) return list[0];
  const index = list.findIndex(item => item.id === cursor);
  return index >= 0 ? (list[index + 1] || null) : list[0];
}

export function acknowledgeWatchCommand(commandID, input = {}) {
  const id = cleanID(commandID, '');
  if (!id) return null;
  const list = liveCommands();
  const index = list.findIndex(item => item.id === id);
  if (index < 0) return null;
  const acknowledgedAt = now();
  list[index] = {
    ...list[index],
    delivery_status: 'executed',
    acknowledged_at: acknowledgedAt,
    executed_pattern: String(input.pattern || list[index].pattern || '').slice(0, 40) || undefined,
    acknowledged_by: String(input.source || 'sigh_watch').slice(0, 80)
  };
  writeJSON(COMMANDS_FILE, list.slice(-200));
  return list[index];
}

export function watchCommandStatus(commandID) {
  const id = cleanID(commandID, '');
  const command = id ? liveCommands().find(item => item.id === id) : null;
  if (!command) return null;
  return {
    id: command.id,
    type: command.type,
    pattern: command.pattern,
    delivery_status: command.acknowledged_at ? 'executed' : 'queued',
    executed_on_watch: !!command.acknowledged_at,
    acknowledged_at: command.acknowledged_at || null
  };
}

export function watchEventReceipt(eventID) {
  const id = cleanID(eventID, '');
  if (!id) return null;
  return liveReceipts().find(item => item.event_id === id) || null;
}

export function recordWatchEventReceipt(eventID, messageID) {
  const id = cleanID(eventID, '');
  if (!id) return null;
  const list = liveReceipts().filter(item => item.event_id !== id);
  const receipt = { event_id: id, message_id: String(messageID || ''), delivered_at: now() };
  list.push(receipt);
  writeJSON(RECEIPTS_FILE, list.slice(-500));
  return receipt;
}

export const WATCH_COMMAND_PATTERNS = [...PATTERNS];
