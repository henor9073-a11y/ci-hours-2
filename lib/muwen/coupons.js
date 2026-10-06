import { file, readJSON, writeJSON, newId, now } from './common.js';
import { sendSystemEvent } from './chat.js';

const FILE = file('coupons.json');

export const VALIDITIES = ['one_day', 'three_days', 'one_week', 'one_month', 'six_months', 'one_year', 'permanent'];
export const PEOPLE = ['nor', 'cy'];

const VALIDITY_LABELS = {
  one_day: '一天', three_days: '三天', one_week: '一周', one_month: '一月',
  six_months: '半年', one_year: '一年', permanent: '永久'
};

function load() {
  const value = readJSON(FILE, []);
  return Array.isArray(value) ? value : [];
}

function save(list) { writeJSON(FILE, list); }

function other(actor) { return actor === 'nor' ? 'cy' : 'nor'; }
function person(actor) { return actor === 'nor' ? '棋子' : '辞'; }

function cleanText(value, name, max) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name}不能为空`);
  if (text.length > max) throw new Error(`${name}最多 ${max} 个字`);
  return text;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function expiryFor(createdAt, validity) {
  if (validity === 'permanent') return null;
  const d = new Date(createdAt);
  if (validity === 'one_day') d.setUTCDate(d.getUTCDate() + 1);
  else if (validity === 'three_days') d.setUTCDate(d.getUTCDate() + 3);
  else if (validity === 'one_week') d.setUTCDate(d.getUTCDate() + 7);
  else if (validity === 'one_month') return addMonths(d, 1).toISOString();
  else if (validity === 'six_months') return addMonths(d, 6).toISOString();
  else if (validity === 'one_year') return addMonths(d, 12).toISOString();
  return d.toISOString();
}

function refreshExpired(list) {
  let changed = false;
  const current = Date.now();
  for (const coupon of list) {
    if (coupon.status !== 'available' || !coupon.expires_at) continue;
    if (new Date(coupon.expires_at).getTime() <= current) {
      coupon.status = 'expired';
      coupon.expired_at = now();
      changed = true;
    }
  }
  if (changed) save(list);
  return list;
}

function publicCoupon(coupon) {
  return {
    ...coupon,
    validity_label: VALIDITY_LABELS[coupon.validity] || coupon.validity,
    revocation_pending: coupon.status === 'available' && (coupon.revocation_requests || []).length === 1
  };
}

export function listCoupons() {
  return refreshExpired(load())
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(publicCoupon);
}

// actor 是写券的人。持券人永远是另一方：棋子从 App 写的券进入辞的券册；辞从 MCP 写的进入棋子的券册。
export async function createCoupon({ actor, title, emoji, description, validity }) {
  if (!PEOPLE.includes(actor)) throw new Error('actor 必须是 nor 或 cy');
  if (!VALIDITIES.includes(validity)) throw new Error(`有效期必须是 ${VALIDITIES.join('/')}`);
  const createdAt = now();
  const coupon = {
    id: newId('cp_'),
    title: cleanText(title, '标题', 40),
    emoji: cleanText(emoji, 'emoji', 12),
    description: cleanText(description, '一句话说明', 120),
    validity,
    issuer: actor,
    holder: other(actor),
    target: actor,
    status: 'available',
    created_at: createdAt,
    expires_at: expiryFor(createdAt, validity),
    revocation_requests: []
  };
  const list = load();
  list.push(coupon);
  save(list);
  await sendSystemEvent(`${person(actor)}写了一张「${coupon.title}」券，放进了${person(coupon.holder)}的券册`, `coupon:${coupon.id}`);
  return publicCoupon(coupon);
}

export async function useCoupon(id, actor) {
  if (!PEOPLE.includes(actor)) throw new Error('actor 必须是 nor 或 cy');
  const list = refreshExpired(load());
  const coupon = list.find(item => item.id === id);
  if (!coupon) throw new Error('找不到这张券');
  if (coupon.status !== 'available') throw new Error('这张券已经不能使用了');
  if (coupon.holder !== actor) throw new Error('只有持券的人可以用这张券');
  coupon.status = 'used';
  coupon.used_at = now();
  coupon.used_by = actor;
  save(list);
  await sendSystemEvent(`${person(actor)}使用了「${coupon.title}」券`, `coupon:${coupon.id}`);
  return publicCoupon(coupon);
}

// 第一次调用是申请；另一方再次调用即同意。只有两个人都同意时才真正撤回。
export async function requestRevocation(id, actor) {
  if (!PEOPLE.includes(actor)) throw new Error('actor 必须是 nor 或 cy');
  const list = refreshExpired(load());
  const coupon = list.find(item => item.id === id);
  if (!coupon) throw new Error('找不到这张券');
  if (coupon.status !== 'available') throw new Error('这张券已经不能撤回了');
  const requests = new Set(Array.isArray(coupon.revocation_requests) ? coupon.revocation_requests : []);
  if (requests.has(actor)) throw new Error('已经申请过撤回，正在等对方同意');
  requests.add(actor);
  coupon.revocation_requests = [...requests];
  if (requests.size === PEOPLE.length) {
    coupon.status = 'revoked';
    coupon.revoked_at = now();
    save(list);
    await sendSystemEvent(`双方同意撤回「${coupon.title}」券`, `coupon:${coupon.id}`);
  } else {
    coupon.revocation_requested_at = now();
    save(list);
    await sendSystemEvent(`${person(actor)}申请撤回「${coupon.title}」券，等待对方同意`, `coupon:${coupon.id}`);
  }
  return publicCoupon(coupon);
}
