import { file, now, readJSON, writeJSON } from './common.js';
import * as chat from './chat.js';

const FILE = file('xinchao-bridge.json');
const PROTOCOL = 'xinchao-runtime-wake/1';
const REASONS = new Set([
  'user_interaction', 'user_note', 'scheduled_interaction', 'user_feedback', 'self_signal'
]);
const USER_LABELS = {
  user_interaction: '互动',
  user_note: '留话',
  scheduled_interaction: '预约',
  user_feedback: '反馈'
};
const ACK_WAIT_MS = Math.max(500, Math.min(Number(process.env.XINCHAO_BRIDGE_ACK_WAIT_MS) || 24_000, 28_000));
const ACK_POLL_MS = Math.max(25, Math.min(Number(process.env.XINCHAO_BRIDGE_ACK_POLL_MS) || 250, 2_000));

function load() {
  const value = readJSON(FILE, { deliveries: [] });
  return { deliveries: Array.isArray(value?.deliveries) ? value.deliveries : [] };
}

function save(value) {
  // 未完成的必须一直留着；已完成的只保留最近 2000 条用于幂等和审计。
  const pending = value.deliveries.filter(item => item.status !== 'delivered');
  const delivered = value.deliveries.filter(item => item.status === 'delivered').slice(-2000);
  writeJSON(FILE, { deliveries: [...pending, ...delivered] });
}

function header(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

export function validateEnvelope(envelope, headers = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('invalid envelope');
  if (envelope.protocol !== PROTOCOL || header(headers, 'x-xinchao-protocol') !== PROTOCOL) {
    throw new Error('unsupported protocol');
  }
  const deliveryId = String(envelope.deliveryId || '').trim();
  if (!/^[A-Za-z0-9._~-]{6,160}$/.test(deliveryId)) throw new Error('invalid deliveryId');
  if (header(headers, 'x-xinchao-delivery-id') !== deliveryId) throw new Error('envelope mismatch');
  const reason = String(envelope.reason || '').trim();
  if (!REASONS.has(reason)) throw new Error('unsupported reason');
  const message = String(envelope.message || '').trim();
  if (!message) throw new Error('empty message');
  if (message.length > 12_000) throw new Error('message too large');
  return { protocol: PROTOCOL, deliveryId, reason, message };
}

function render(envelope) {
  if (envelope.reason === 'self_signal') {
    return {
      content: `心潮｜${envelope.message}`,
      deliveryText: `【心潮】${envelope.message}`,
      action: 'xinchao_self_signal'
    };
  }
  const label = USER_LABELS[envelope.reason] || '消息';
  const compact = envelope.message.replace(/\s+/g, ' ');
  return {
    content: `心潮小屋·${label}｜${compact}`,
    deliveryText: `【心潮小屋·${label}】${compact}（心潮小屋递来的，心里有数就行，不用特意回。）`,
    action: `xinchao_${envelope.reason}`
  };
}

function find(deliveryId) {
  return load().deliveries.find(item => item.delivery_id === deliveryId) || null;
}

export async function enqueueEnvelope(envelope) {
  const existing = find(envelope.deliveryId);
  if (existing) return deliveryStatus(envelope.deliveryId);

  const rendered = render(envelope);
  const message = await chat.sendSystemEvent(rendered.content, rendered.action, {
    deliverToCy: true,
    deliveryKey: `xinchao:${envelope.deliveryId}`,
    deliveryText: rendered.deliveryText,
    sourceDevice: 'xinchao_bridge'
  });
  const state = load();
  const raced = state.deliveries.find(item => item.delivery_id === envelope.deliveryId);
  if (!raced) {
    state.deliveries.push({
      delivery_id: envelope.deliveryId,
      reason: envelope.reason,
      message_id: message.id,
      status: message.delivered_at ? 'delivered' : 'queued',
      received_at: now(),
      delivered_at: message.delivered_at || null
    });
    save(state);
  }
  return deliveryStatus(envelope.deliveryId);
}

export function deliveryStatus(deliveryId) {
  const state = load();
  const record = state.deliveries.find(item => item.delivery_id === String(deliveryId || ''));
  if (!record) return null;
  const message = chat.getMessage(record.message_id);
  const deliveredAt = message?.delivered_at || record.delivered_at || null;
  if (deliveredAt && record.status !== 'delivered') {
    record.status = 'delivered';
    record.delivered_at = deliveredAt;
    save(state);
  }
  return {
    deliveryId: record.delivery_id,
    reason: record.reason,
    messageId: record.message_id,
    status: deliveredAt ? 'delivered' : 'queued',
    deliveredAt
  };
}

export async function waitForDelivery(deliveryId, timeoutMs = ACK_WAIT_MS) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  do {
    const status = deliveryStatus(deliveryId);
    if (!status) throw new Error('delivery not found');
    if (status.status === 'delivered') return status;
    if (Date.now() >= deadline) return status;
    await new Promise(resolve => setTimeout(resolve, ACK_POLL_MS));
  } while (true);
}

export function bridgeStatus() {
  const records = load().deliveries;
  return {
    protocol: PROTOCOL,
    queued: records.filter(item => deliveryStatus(item.delivery_id)?.status !== 'delivered').length,
    delivered: records.filter(item => deliveryStatus(item.delivery_id)?.status === 'delivered').length
  };
}
