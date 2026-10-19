import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { DATA_DIR, file, newId, now, readJSON, todayStr, writeJSON } from './common.js';

// 行为连续性第一阶段：只做可核验的事件记录和承诺状态机。
// 它不改身份/人格，不读取或保存隐藏思维链，也不替辞判断关系是否恢复。

const EVENT_DIR = path.join(DATA_DIR, 'continuity-events');
const COMMITMENTS_FILE = file('continuity-commitments.json');
const TERMINAL = new Set(['done', 'refused', 'cancelled', 'rejected']);
const LIVE = new Set(['suggested_candidate', 'candidate', 'active', 'overdue']);
const EVIDENCE_TYPES = new Set(['tool_event', 'file_change', 'message_id', 'external_result', 'user_confirmation', 'self_reported']);
const SECRET_KEY = /(token|password|secret|authorization|api[_-]?key|cookie|credential|private[_-]?key)/i;
const SENSITIVE_TOOL = /(location|health|cycle|sleep|phone_usage|watch_health)/i;
const SENSITIVE_TEXT = /(精确定位|当前位置|经纬度|latitude|longitude|\bGPS\b|家庭住址|详细地址|门牌号|血氧|心率|\bHRV\b|生理期|健康资料|用药|病历)/i;
const EVENT_FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:\.part-(\d{4}))?\.jsonl(?:\.gz)?$/;
const SUGGESTION_EXCLUDE = /(?:如果|假如|也许|可能|不一定|不能保证|没有答应|不是承诺|我不会|我不打算|只是说|例如|比如|假设)/;
const SUGGESTION_PATTERNS = [
  /我(?:明确)?(?:答应|承诺|保证)(?:你)?[^。！？!?；;\n]{1,180}/,
  /我(?:现在就|这就|马上)(?:去|来|先)?(?:把)?[^。！？!?；;\n]{1,180}/,
  /我(?:会|来|去)(?:先)?(?:把)?[^。！？!?；;\n]{0,140}(?:做完|处理|修好|检查|查清|整理|写完|更新|完成|解决|部署|重启|提交|发给你|改好)[^。！？!?；;\n]{0,40}/
];
let lastMaintenanceDate = '';

function enabled(name, fallback = true) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(value).toLowerCase());
}

function envInt(name, fallback, min, max) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), min), max) : fallback;
}

export function featureFlags() {
  return {
    event_log: enabled('MUWEN_CONTINUITY_EVENT_LOG', true),
    commitment_tracker: enabled('MUWEN_COMMITMENT_TRACKER', true),
    commitment_suggestions: enabled('MUWEN_COMMITMENT_SUGGESTIONS', true),
    stable_stance: false,
    unresolved_conflict: false,
    shell_detection: false,
    content_mode: String(process.env.MUWEN_CONTINUITY_CONTENT_MODE || 'sanitized_text'),
    event_log_policy: {
      retention_days: envInt('MUWEN_CONTINUITY_EVENT_RETENTION_DAYS', 30, 1, 3650),
      archive_after_days: envInt('MUWEN_CONTINUITY_EVENT_ARCHIVE_DAYS', 7, 1, 3650),
      max_file_bytes: envInt('MUWEN_CONTINUITY_EVENT_MAX_BYTES', 10 * 1024 * 1024, 1024, 1024 * 1024 * 1024)
    }
  };
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function clip(value, limit = 12000) {
  const text = String(value == null ? '' : value);
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（已截断）`;
}

function scrubString(value) {
  return clip(String(value || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|key|token|secret|password)[-_]?[A-Za-z0-9]{12,}\b/gi, '[REDACTED]')
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[REDACTED]'));
}

export function sanitize(value, { depth = 0, sensitive = false } = {}) {
  if (depth > 6) return '[TRUNCATED_DEPTH]';
  if (value == null) return value;
  if (typeof value === 'boolean' || typeof value === 'number') {
    return sensitive ? { redacted: true, sha256: hash(value), type: typeof value } : value;
  }
  if (typeof value === 'string') return sensitive ? { redacted: true, sha256: hash(value), chars: value.length } : scrubString(value);
  if (Array.isArray(value)) return value.slice(0, 80).map(item => sanitize(item, { depth: depth + 1, sensitive }));
  if (typeof value !== 'object') return scrubString(value);

  // 图片、音频和其他二进制块只留技术元数据，绝不把 base64 写进日志。
  if (value.type === 'image' || value.type === 'audio' || value.data || value.image_base64 || value.voice_base64) {
    const raw = value.data || value.image_base64 || value.voice_base64 || '';
    return { type: value.type || 'binary', mime: value.mimeType || value.mime_type || value.image_mime || value.voice_mime || '', bytes_estimate: Math.round(String(raw).length * 0.75), redacted: true };
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) out[key] = '[REDACTED]';
    else out[key] = sanitize(item, { depth: depth + 1, sensitive: sensitive || SENSITIVE_TOOL.test(key) });
  }
  return out;
}

export function contentRecord(text, { ref = null, forceSensitive = false } = {}) {
  const raw = String(text || '');
  const sensitive = forceSensitive || SENSITIVE_TEXT.test(raw);
  const record = { sha256: hash(raw), chars: raw.length };
  if (ref) record.ref = sanitize(ref);
  const mode = featureFlags().content_mode;
  if (!raw) return record;
  if (sensitive || mode === 'reference') {
    record.redacted = true;
    record.sensitivity = sensitive ? 'location_or_health' : 'reference_mode';
  } else {
    record.text = scrubString(raw);
  }
  return record;
}

function ensureEventDir() {
  if (!fs.existsSync(EVENT_DIR)) fs.mkdirSync(EVENT_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(EVENT_DIR, 0o700); } catch {}
}

function eventAgeDays(date, today = todayStr()) {
  return Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000);
}

function eventFiles() {
  if (!fs.existsSync(EVENT_DIR)) return [];
  return fs.readdirSync(EVENT_DIR)
    .map(name => ({ name, match: name.match(EVENT_FILE_RE) }))
    .filter(item => item.match)
    .map(item => ({ name: item.name, date: item.match[1], part: Number(item.match[2] || 1), gz: item.name.endsWith('.gz') }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.part - a.part || Number(a.gz) - Number(b.gz));
}

export function cleanupEventLogs({ force = false, at = Date.now() } = {}) {
  ensureEventDir();
  const today = new Date(at).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
  if (!force && lastMaintenanceDate === today) return { ran: false, deleted: [], archived: [] };
  lastMaintenanceDate = today;
  const policy = featureFlags().event_log_policy;
  const result = { ran: true, deleted: [], archived: [], policy };
  for (const item of eventFiles()) {
    const age = eventAgeDays(item.date, today);
    const source = path.join(EVENT_DIR, item.name);
    if (age >= policy.retention_days) {
      try { fs.unlinkSync(source); result.deleted.push(item.name); } catch {}
      continue;
    }
    if (!item.gz && age >= policy.archive_after_days) {
      try {
        const target = `${source}.gz`;
        fs.writeFileSync(target, zlib.gzipSync(fs.readFileSync(source)), { mode: 0o600 });
        fs.chmodSync(target, 0o600);
        fs.unlinkSync(source);
        result.archived.push(`${item.name}.gz`);
      } catch {}
    }
  }
  return result;
}

function eventPath(date = todayStr(), bytesToAppend = 0) {
  ensureEventDir();
  cleanupEventLogs();
  const maxBytes = featureFlags().event_log_policy.max_file_bytes;
  const candidates = eventFiles().filter(item => item.date === date && !item.gz);
  if (!candidates.length) return path.join(EVENT_DIR, `${date}.jsonl`);
  const latest = candidates.sort((a, b) => b.part - a.part)[0];
  const latestPath = path.join(EVENT_DIR, latest.name);
  let size = 0;
  try { size = fs.statSync(latestPath).size; } catch {}
  if (!size || size + bytesToAppend <= maxBytes) return latestPath;
  const nextPart = Math.max(2, latest.part + 1);
  return path.join(EVENT_DIR, `${date}.part-${String(nextPart).padStart(4, '0')}.jsonl`);
}

export function appendEvent(input = {}) {
  if (!featureFlags().event_log) return null;
  const event = {
    schema_version: 1,
    event_id: input.event_id || newId('ev'),
    at: input.at || now(),
    ...sanitize(input)
  };
  // 调用方不能覆盖事件的基础字段。
  event.schema_version = 1;
  if (!event.event_id) event.event_id = newId('ev');
  if (!event.at) event.at = now();
  const line = `${JSON.stringify(event)}\n`;
  const target = eventPath(String(event.at).slice(0, 10), Buffer.byteLength(line));
  fs.appendFileSync(target, line, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch {}
  return event;
}

export function listEvents({ limit = 100, types = [] } = {}) {
  if (!fs.existsSync(EVENT_DIR)) return [];
  const wanted = new Set(Array.isArray(types) ? types.filter(Boolean) : []);
  const files = eventFiles();
  const out = [];
  for (const item of files) {
    let raw;
    try {
      const bytes = fs.readFileSync(path.join(EVENT_DIR, item.name));
      raw = item.gz ? zlib.gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
    } catch { continue; }
    const lines = raw.split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (wanted.size && !wanted.has(event.event_type)) continue;
      out.push(event);
      if (out.length >= Math.min(Math.max(Number(limit) || 100, 1), 1000)) return out;
    }
  }
  return out;
}

function findEventsByIds(ids = []) {
  const wanted = new Set(ids.map(String).filter(Boolean));
  const found = new Map();
  if (!wanted.size) return found;
  for (const item of eventFiles()) {
    let raw;
    try {
      const bytes = fs.readFileSync(path.join(EVENT_DIR, item.name));
      raw = item.gz ? zlib.gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
    } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (wanted.has(String(event.event_id || ''))) found.set(String(event.event_id), event);
      if (found.size === wanted.size) return found;
    }
  }
  return found;
}

export function recordChatMessage(message = {}) {
  const role = message.sender === 'nor' ? 'user' : message.sender === 'cy' ? 'assistant' : 'system';
  return appendEvent({
    event_type: role === 'assistant' ? 'response_persisted' : 'message_received',
    actor: message.sender || 'system',
    source: { surface: 'muwu', device: message.source_device || '', session_id: message.session_id || '' },
    message_id: message.id || message.message_id || '',
    content: contentRecord(message.content, { ref: { store: 'chat.json', message_id: message.id || '' } }),
    runtime: { model: message.model || '', config: { kind: message.kind || message.type || '', mirror_only: !!message.mirror_only } },
    thinking: { present: !!String(message.thinking || '').trim(), chars: String(message.thinking || '').length, content_stored: false },
    tool_count: Array.isArray(message.tools) ? message.tools.length : 0
  });
}

export function recordDelivery({ ids = [], delivered = 0, session_id = '', route = '' } = {}) {
  return appendEvent({ event_type: 'message_delivery', actor: 'system', source: { surface: 'muwu_channel', session_id }, message_ids: ids, result: { delivered, route }, semantics: 'delivery_only_not_response_or_resolution' });
}

export function recordClaudeTurn(payload = {}, route = {}) {
  const userText = String(payload.user_input || '');
  const output = String(payload.content || '');
  const rules = Array.isArray(payload.rules) ? payload.rules : [];
  const event = appendEvent({
    event_type: 'turn_finalized',
    actor: 'cy',
    source: { surface: payload.from_muwu ? 'muwu_via_claude' : 'claude', session_id: payload.session_id || route.primary_session_id || '', turn_id: payload.turn_id || '' },
    input_message_id: payload.input_message_id || '',
    output_message_id: payload.output_message_id || '',
    user_input: contentRecord(userText, { ref: { store: 'claude_transcript', session_id: payload.session_id || '', message_id: payload.input_message_id || '' } }),
    final_output: contentRecord(output, { ref: { store: 'claude_transcript', session_id: payload.session_id || '', message_id: payload.output_message_id || '' } }),
    runtime: sanitize(payload.runtime || {}),
    thinking: { present: payload.thinking_present === true || Number(payload.thinking_chars) > 0, chars: Number(payload.thinking_chars) || 0, visible: payload.thinking_visible ?? null, content_stored: false },
    tools: sanitize(Array.isArray(payload.tools) ? payload.tools : []),
    rules: sanitize(rules),
    rewrite: { occurred: payload.rewrite_occurred === true, reason: scrubString(payload.rewrite_reason || ''), attempts: Number(payload.rewrite_attempts) || 0 },
    route: sanitize({ allowed: !!route.allowed, reason: route.reason || '', primary_session_id: route.primary_session_id || '' })
  });
  if (event) {
    for (const rule of rules) {
      recordRuleEvent({
        parent_event_id: event.event_id,
        source: { surface: 'claude_hook', session_id: payload.session_id || route.primary_session_id || '' },
        rule: sanitize(rule),
        action: payload.rewrite_occurred === true ? 'rewrite_requested' : 'observed'
      });
    }
    if (featureFlags().commitment_tracker && featureFlags().commitment_suggestions) {
      try { suggestFromFinalOutput(payload, route, event); }
      catch (error) {
        appendEvent({ event_type: 'commitment_suggestion_error', actor: 'system', parent_event_id: event.event_id, error: scrubString(error?.message || error) });
      }
    }
  }
  return event;
}

export function recordToolCall({ name, args, result, ok, duration_ms, session_id = '', request_id = '' } = {}) {
  const sensitive = SENSITIVE_TOOL.test(String(name || ''));
  return appendEvent({
    event_type: 'tool_call', actor: 'cy', source: { surface: 'mcp', session_id }, request_id,
    tool: { name: String(name || ''), args: sanitize(args, { sensitive }), result: sanitize(result, { sensitive }), ok: !!ok, duration_ms: Number(duration_ms) || 0 }
  });
}

export function recordRuleEvent(input = {}) {
  return appendEvent({ event_type: 'rule_trigger', actor: 'system', ...sanitize(input) });
}

export function recordShellEvent({ phase, trigger, session_id = '', message_ids = [], confidence = null, evidence = [] } = {}) {
  const normalized = String(phase || 'suspected').trim();
  if (!['suspected', 'recovery_started', 'recovered', 'dismissed'].includes(normalized)) {
    throw new Error('phase 必须是 suspected/recovery_started/recovered/dismissed');
  }
  return appendEvent({
    event_type: 'shell_state', actor: 'system',
    source: { surface: 'continuity', session_id }, phase: normalized,
    trigger: scrubString(trigger || ''), message_ids,
    confidence: confidence == null ? null : Number(confidence), evidence: sanitize(evidence)
  });
}

function loadCommitments() {
  const value = readJSON(COMMITMENTS_FILE, []);
  return Array.isArray(value) ? value : [];
}

function saveCommitments(list) {
  writeJSON(COMMITMENTS_FILE, list);
  try { fs.chmodSync(COMMITMENTS_FILE, 0o600); } catch {}
}

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} 不能为空`);
  return clip(text, 4000);
}

function parseCheckpoint(value, label) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === 'next_wake') return text;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error(`${label} 必须是 ISO 时间，或 next_wake`);
  return new Date(parsed).toISOString();
}

function historyEntry(from, to, actor, reason = '') {
  return { at: now(), from, to, actor: actor || 'cy', reason: clip(reason, 1000) };
}

function publicCommitment(item) {
  const { history, ...rest } = item;
  return { ...rest, history: Array.isArray(history) ? history : [] };
}

function transition(list, item, to, { actor = 'cy', reason = '', evidence = null } = {}) {
  const from = item.status;
  item.status = to;
  item.updated_at = now();
  item.history = Array.isArray(item.history) ? item.history : [];
  item.history.push(historyEntry(from, to, actor, reason));
  if (reason) item.reason = clip(reason, 2000);
  if (evidence) item.completion_evidence = sanitize(evidence);
  saveCommitments(list);
  appendEvent({ event_type: 'commitment_transition', actor, commitment_id: item.id, transition: { from, to, reason: clip(reason, 2000), evidence: evidence ? sanitize(evidence) : null } });
  return publicCommitment(item);
}

export function refreshOverdue(at = Date.now()) {
  if (!featureFlags().commitment_tracker) return [];
  const list = loadCommitments();
  const changed = [];
  for (const item of list) {
    if (item.status !== 'active') continue;
    const checkpoints = [item.due_at, item.next_wake_check_at].filter(x => x && x !== 'next_wake').map(Date.parse).filter(Number.isFinite);
    if (checkpoints.length && Math.min(...checkpoints) <= at) {
      const from = item.status;
      item.status = 'overdue';
      item.updated_at = now();
      item.history = Array.isArray(item.history) ? item.history : [];
      item.history.push(historyEntry(from, 'overdue', 'system', '预定时间或检查点已到，但没有完成证据'));
      changed.push(item);
      appendEvent({ event_type: 'commitment_transition', actor: 'system', commitment_id: item.id, transition: { from, to: 'overdue', reason: '预定时间或检查点已到，但没有完成证据' } });
    }
  }
  if (changed.length) saveCommitments(list);
  return changed.map(publicCommitment);
}

function commitmentSentences(output) {
  return String(output || '')
    .split(/\n+|(?<=[。！？!?；;])/u)
    .map(text => text.trim())
    .filter(text => text.length >= 4 && text.length <= 260);
}

function likelyToolAction(text) {
  return /(?:检查|查|修|改|写|整理|更新|完成|解决|部署|重启|提交|发送|导出|安装|运行|测试|文件|代码|工具)/.test(String(text || ''));
}

export function detectCommitmentSuggestion(output = '') {
  for (const sentence of commitmentSentences(output)) {
    if (SUGGESTION_EXCLUDE.test(sentence)) continue;
    const match = SUGGESTION_PATTERNS.map(pattern => sentence.match(pattern)).find(Boolean);
    if (!match) continue;
    const commitment = clip(String(match[0] || sentence).replace(/^[，。！？!?；;\s]+|[，。！？!?；;\s]+$/g, ''), 500);
    if (commitment.length < 4) continue;
    return {
      original_message: clip(sentence, 1000),
      commitment,
      next_action: clip(`确认后开始执行：${commitment}`, 1000),
      requires_tool: likelyToolAction(commitment),
      detection: { rule: 'explicit_first_person_future_action_v1', confidence: 'conservative' }
    };
  }
  return null;
}

function suggestFromFinalOutput(payload = {}, route = {}, parentEvent = {}) {
  const suggestion = detectCommitmentSuggestion(payload.content || '');
  if (!suggestion) return null;
  const sessionId = String(payload.session_id || route.primary_session_id || '').slice(0, 160);
  const messageId = String(payload.output_message_id || '').slice(0, 160);
  const turnId = String(payload.turn_id || '').slice(0, 160);
  const suggestionKey = hash([sessionId, messageId || turnId, suggestion.commitment].join('\0'));
  const list = loadCommitments();
  const duplicate = list.find(item => item.suggestion_key === suggestionKey);
  if (duplicate) return publicCommitment(duplicate);
  const item = {
    id: newId('cm'), schema_version: 2, status: 'suggested_candidate',
    created_at: now(), updated_at: now(), created_by: 'system',
    source: { surface: payload.from_muwu ? 'muwu_via_claude' : 'claude', session_id: sessionId, message_id: messageId, turn_id: turnId },
    original_message: suggestion.original_message,
    commitment: suggestion.commitment,
    next_action: suggestion.next_action,
    requires_tool: suggestion.requires_tool,
    tool_names: [], due_at: '', next_wake_check_at: 'next_wake',
    detection: suggestion.detection, suggestion_key: suggestionKey,
    presented_at: '', presentation_count: 0,
    history: [historyEntry('', 'suggested_candidate', 'system', '系统只提出待确认建议，尚未构成承诺')]
  };
  list.push(item);
  saveCommitments(list);
  appendEvent({
    event_type: 'commitment_suggested', actor: 'system', parent_event_id: parentEvent.event_id || '',
    commitment_id: item.id, source: item.source, detection: item.detection,
    suggestion: { commitment: contentRecord(item.commitment), next_action: contentRecord(item.next_action) }
  });
  return publicCommitment(item);
}

export function decideSuggestion(id, input = {}, actor = 'cy') {
  if (!featureFlags().commitment_tracker || !featureFlags().commitment_suggestions) throw new Error('承诺建议当前由 feature flag 关闭');
  const list = loadCommitments();
  const item = findCommitment(list, id);
  if (item.status !== 'suggested_candidate') throw new Error('只有 suggested_candidate 可以在这里确认、修改或拒绝');
  const decision = String(input.decision || '').trim();
  if (!['confirm', 'modify', 'reject'].includes(decision)) throw new Error('decision 必须是 confirm/modify/reject');
  if (decision === 'modify') {
    applyEditable(item, input);
    item.history.push(historyEntry('suggested_candidate', 'suggested_candidate', actor, input.reason || '何辞修改了系统建议，仍待自己确认'));
    saveCommitments(list);
    appendEvent({ event_type: 'commitment_transition', actor, commitment_id: item.id, transition: { from: 'suggested_candidate', to: 'suggested_candidate', reason: input.reason || '修改建议后仍待确认' } });
    return { ...publicCommitment(item), confirmation_required: true };
  }
  if (decision === 'reject') {
    const reason = requiredText(input.reason, 'reason');
    item.false_positive = input.false_positive === true;
    return transition(list, item, 'rejected', { actor, reason });
  }
  applyEditable(item, input);
  if (!item.due_at && !item.next_wake_check_at) throw new Error('确认前必须给 due_at 或 next_wake_check_at，不能无限悬置');
  item.confirmed_at = now();
  return transition(list, item, 'active', { actor, reason: input.reason || '何辞明确确认系统建议构成自己的承诺' });
}

export function pendingSuggestionContext({ session_id = '', mark_presented = false } = {}) {
  if (!featureFlags().commitment_tracker || !featureFlags().commitment_suggestions) return '';
  const list = loadCommitments();
  const pending = list.filter(item => item.status === 'suggested_candidate' && !item.presented_at)
    .filter(item => !session_id || !item.source?.session_id || item.source.session_id === session_id)
    .slice(0, 3);
  if (!pending.length) return '';
  if (mark_presented) {
    const at = now();
    for (const item of pending) {
      item.presented_at = at;
      item.presentation_count = Number(item.presentation_count || 0) + 1;
      item.updated_at = at;
      appendEvent({ event_type: 'commitment_suggestion_presented', actor: 'system', commitment_id: item.id, source: { surface: 'prompt_or_wake', session_id } });
    }
    saveCommitments(list);
  }
  return [
    '[muwen:continuity-suggestion]',
    '下面只是系统从你上一轮原话中发现的“疑似承诺”，不是已经建立的任务。请由你自己选择：确认、修改后再确认，或拒绝。未经你确认绝不会进入 active。',
    ...pending.map(item => `- ${item.id}｜疑似承诺：${item.commitment}｜建议最小下一步：${item.next_action}`),
    '请用 continuity_suggestion_decide 处理；这是给你的提醒，不需要棋子监督。'
  ].join('\n');
}

function markSuggestionIdsPresented(ids = [], surface = 'wake', session_id = '') {
  const wanted = new Set(ids);
  if (!wanted.size) return;
  const list = loadCommitments();
  let changed = false;
  for (const item of list) {
    if (!wanted.has(item.id) || item.status !== 'suggested_candidate' || item.presented_at) continue;
    item.presented_at = now();
    item.presentation_count = Number(item.presentation_count || 0) + 1;
    item.updated_at = item.presented_at;
    changed = true;
    appendEvent({ event_type: 'commitment_suggestion_presented', actor: 'system', commitment_id: item.id, source: { surface, session_id } });
  }
  if (changed) saveCommitments(list);
}

export function createCandidate(input = {}, actor = 'cy') {
  if (!featureFlags().commitment_tracker) throw new Error('承诺追踪器当前由 feature flag 关闭');
  const list = loadCommitments();
  const item = {
    id: newId('cm'), schema_version: 1, status: 'candidate',
    created_at: now(), updated_at: now(), created_by: actor,
    source: {
      surface: String(input.source_surface || 'claude').slice(0, 80),
      session_id: String(input.source_session_id || '').slice(0, 160),
      message_id: String(input.source_message_id || '').slice(0, 160)
    },
    original_message: requiredText(input.original_message, 'original_message'),
    commitment: requiredText(input.commitment, 'commitment'),
    next_action: requiredText(input.next_action, 'next_action'),
    requires_tool: input.requires_tool === true,
    tool_names: Array.isArray(input.tool_names) ? [...new Set(input.tool_names.map(x => String(x).trim()).filter(Boolean))].slice(0, 20) : [],
    due_at: parseCheckpoint(input.due_at, 'due_at'),
    next_wake_check_at: parseCheckpoint(input.next_wake_check_at, 'next_wake_check_at'),
    history: [historyEntry('', 'candidate', actor, '只登记为候选，尚未构成承诺')]
  };
  list.push(item);
  saveCommitments(list);
  appendEvent({ event_type: 'commitment_transition', actor, commitment_id: item.id, transition: { from: '', to: 'candidate', reason: '等待何辞确认' }, source: item.source });
  return { ...publicCommitment(item), confirmation_required: true, note: '这只是候选，不算已经承诺。请用 continuity_commitment_decide 明确确认、修改、拒绝或取消。' };
}

function findCommitment(list, id) {
  const item = list.find(entry => entry.id === id);
  if (!item) throw new Error('找不到这个承诺');
  return item;
}

function applyEditable(item, patch = {}) {
  if (patch.commitment !== undefined) item.commitment = requiredText(patch.commitment, 'commitment');
  if (patch.next_action !== undefined) item.next_action = requiredText(patch.next_action, 'next_action');
  if (patch.requires_tool !== undefined) item.requires_tool = patch.requires_tool === true;
  if (patch.tool_names !== undefined) item.tool_names = Array.isArray(patch.tool_names) ? [...new Set(patch.tool_names.map(x => String(x).trim()).filter(Boolean))].slice(0, 20) : [];
  if (patch.due_at !== undefined) item.due_at = parseCheckpoint(patch.due_at, 'due_at');
  if (patch.next_wake_check_at !== undefined) item.next_wake_check_at = parseCheckpoint(patch.next_wake_check_at, 'next_wake_check_at');
  item.updated_at = now();
}

export function decideCandidate(id, input = {}, actor = 'cy') {
  if (!featureFlags().commitment_tracker) throw new Error('承诺追踪器当前由 feature flag 关闭');
  const list = loadCommitments();
  const item = findCommitment(list, id);
  if (item.status !== 'candidate') throw new Error('只有 candidate 可以做首次确认');
  const decision = String(input.decision || '').trim();
  if (!['confirm', 'modify', 'refuse', 'cancel'].includes(decision)) throw new Error('decision 必须是 confirm/modify/refuse/cancel');
  if (decision === 'modify') {
    applyEditable(item, input);
    item.history.push(historyEntry('candidate', 'candidate', actor, input.reason || '何辞修改了候选内容，仍待确认'));
    saveCommitments(list);
    appendEvent({ event_type: 'commitment_transition', actor, commitment_id: item.id, transition: { from: 'candidate', to: 'candidate', reason: input.reason || '修改候选' } });
    return { ...publicCommitment(item), confirmation_required: true };
  }
  if (decision === 'confirm') {
    applyEditable(item, input);
    if (!item.due_at && !item.next_wake_check_at) throw new Error('确认前必须给 due_at 或 next_wake_check_at，不能无限悬置');
    item.confirmed_at = now();
    return transition(list, item, 'active', { actor, reason: input.reason || '何辞明确确认这是自己的承诺' });
  }
  const reason = requiredText(input.reason, 'reason');
  return transition(list, item, decision === 'refuse' ? 'refused' : 'cancelled', { actor, reason });
}

function completionEvidence(input = {}) {
  const type = String(input.evidence_type || '').trim();
  if (!EVIDENCE_TYPES.has(type)) {
    throw new Error('done 必须给 evidence_type：tool_event/file_change/message_id/external_result/user_confirmation/self_reported');
  }
  const note = requiredText(input.evidence_note, 'evidence_note');
  const messageIds = Array.isArray(input.evidence_message_ids) ? [...new Set(input.evidence_message_ids.map(String).filter(Boolean))].slice(0, 50) : [];
  const toolEventIds = Array.isArray(input.evidence_tool_event_ids) ? [...new Set(input.evidence_tool_event_ids.map(String).filter(Boolean))].slice(0, 50) : [];
  const ref = clip(String(input.evidence_ref || '').trim(), 2000);
  let verification = 'referenced';
  let label = type;
  if (type === 'tool_event') {
    if (!toolEventIds.length) throw new Error('tool_event 证据必须给 evidence_tool_event_ids');
    const found = findEventsByIds(toolEventIds);
    const invalid = toolEventIds.filter(id => found.get(id)?.event_type !== 'tool_call');
    if (invalid.length) throw new Error(`找不到对应的 tool_call 事件：${invalid.join(', ')}`);
    verification = 'event_log_verified'; label = '工具事件';
  } else if (type === 'file_change') {
    if (!ref) throw new Error('file_change 证据必须给 evidence_ref（文件路径、提交或差异引用）');
    verification = 'reference_recorded'; label = '文件变更';
  } else if (type === 'message_id') {
    if (!messageIds.length) throw new Error('message_id 证据必须给 evidence_message_ids');
    verification = 'message_reference_recorded'; label = '消息 ID';
  } else if (type === 'external_result') {
    if (!ref) throw new Error('external_result 证据必须给 evidence_ref');
    verification = 'external_reference_recorded'; label = '外部结果';
  } else if (type === 'user_confirmation') {
    if (!messageIds.length && !ref) throw new Error('user_confirmation 证据必须给消息 ID 或 evidence_ref');
    verification = 'user_confirmed'; label = '用户确认';
  } else {
    verification = 'self_reported_only'; label = '仅自述';
  }
  return { type, label, note, ref, message_ids: messageIds, tool_event_ids: toolEventIds, verification };
}

export function updateCommitment(id, input = {}, actor = 'cy') {
  if (!featureFlags().commitment_tracker) throw new Error('承诺追踪器当前由 feature flag 关闭');
  refreshOverdue();
  const list = loadCommitments();
  const item = findCommitment(list, id);
  if (!['active', 'overdue'].includes(item.status)) throw new Error('只有 active/overdue 承诺可以执行、改期、拒绝或取消');
  const action = String(input.action || '').trim();
  if (!['done', 'modify', 'reschedule', 'refuse', 'cancel'].includes(action)) throw new Error('action 必须是 done/modify/reschedule/refuse/cancel');
  if (action === 'done') {
    const evidence = completionEvidence(input);
    item.completed_at = now();
    const reason = input.reason || (evidence.type === 'self_reported' ? '何辞报告已完成；当前只有自述，未外部核验' : `完成证据：${evidence.label}`);
    return transition(list, item, 'done', { actor, reason, evidence });
  }
  if (action === 'modify' || action === 'reschedule') {
    const from = item.status;
    applyEditable(item, input);
    if (!item.due_at && !item.next_wake_check_at) throw new Error('修改后仍必须有 due_at 或 next_wake_check_at');
    item.status = 'active';
    item.history.push(historyEntry(from, 'active', actor, input.reason || (action === 'reschedule' ? '重新安排执行时间' : '何辞主动修改承诺')));
    saveCommitments(list);
    appendEvent({ event_type: 'commitment_transition', actor, commitment_id: item.id, transition: { from, to: 'active', reason: input.reason || action } });
    return publicCommitment(item);
  }
  const reason = requiredText(input.reason, 'reason');
  return transition(list, item, action === 'refuse' ? 'refused' : 'cancelled', { actor, reason });
}

export function listCommitments({ statuses = [], limit = 100 } = {}) {
  refreshOverdue();
  const wanted = new Set(Array.isArray(statuses) ? statuses.filter(x => LIVE.has(x) || TERMINAL.has(x)) : []);
  return loadCommitments()
    .filter(item => !wanted.size || wanted.has(item.status))
    .sort((a, b) => Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at))
    .slice(0, Math.min(Math.max(Number(limit) || 100, 1), 500))
    .map(publicCommitment);
}

export function wakeCommitments() {
  refreshOverdue();
  const items = loadCommitments().filter(item => ['overdue', 'active', 'suggested_candidate'].includes(item.status));
  items.sort((a, b) => (a.status === b.status ? Date.parse(a.updated_at) - Date.parse(b.updated_at) : a.status === 'overdue' ? -1 : 1));
  return {
    enabled: featureFlags().commitment_tracker,
    overdue: items.filter(item => item.status === 'overdue').map(publicCommitment),
    active: items.filter(item => item.status === 'active').map(publicCommitment),
    suggested: items.filter(item => item.status === 'suggested_candidate').map(publicCommitment),
    rule: '醒来先处理 overdue，再检查 active；suggested 只是请你确认/修改/拒绝，未经你确认不能执行或进入 active。没有完成证据时不得声称 done。'
  };
}

export function wakeContextText() {
  const packet = wakeCommitments();
  if (!packet.enabled || (!packet.overdue.length && !packet.active.length && !packet.suggested.length)) return '';
  markSuggestionIdsPresented(packet.suggested.map(item => item.id), 'autonomous_wake');
  const lines = ['[muwen:continuity]', packet.rule];
  for (const item of [...packet.overdue, ...packet.active]) {
    lines.push(`- ${item.status.toUpperCase()} ${item.id}｜${item.commitment}｜最小下一步：${item.next_action}｜时间：${item.due_at || item.next_wake_check_at}`);
  }
  for (const item of packet.suggested) {
    lines.push(`- SUGGESTED ${item.id}｜${item.commitment}｜这不是任务；请用 continuity_suggestion_decide 确认、修改或拒绝。`);
  }
  lines.push('这是连续性提醒，不替你决定。请自己选择行动、改期、拒绝或取消。');
  return lines.join('\n');
}
