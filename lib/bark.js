// 手机通知的统一出口：APNs 原生推送优先，Bark 作为过渡期兜底。
// 保留这个文件名是为了不让旧调用方一次全部断掉。
import http2 from 'http2';
import crypto from 'crypto';
import { file, readJSON, writeJSON, newId, now, todayStr } from './muwen/common.js';

const BARK_KEY = process.env.BARK_KEY;
const LOG = file('push-log.json');
const DEVICES = file('push-devices.json');
const KEEP = 300;

const APNS_TEAM_ID = process.env.APNS_TEAM_ID || '';
const APNS_KEY_ID = process.env.APNS_KEY_ID || '';
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.nor.cy';
const APNS_PRIVATE_KEY = (process.env.APNS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const APNS_READY = Boolean(APNS_TEAM_ID && APNS_KEY_ID && APNS_PRIVATE_KEY && APNS_BUNDLE_ID);

// 推过什么以前推完就没了，木屋要看历史，所以每次都记一条（成功失败都记）。
function log(entry) {
  try {
    const l = readJSON(LOG, []);
    l.push({ id: newId('ps'), at: now(), date: todayStr(), ...entry });
    writeJSON(LOG, l.slice(-KEEP));
  } catch { /* 记不上不影响推送本身 */ }
}
export function getPushHistory(limit = 100) {
  return readJSON(LOG, []).slice(-limit).reverse();
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function apnsJWT() {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: APNS_KEY_ID }));
  const claims = base64url(JSON.stringify({ iss: APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign(null, Buffer.from(unsigned), {
    key: crypto.createPrivateKey(APNS_PRIVATE_KEY),
    dsaEncoding: 'ieee-p1363'
  });
  return `${unsigned}.${signature.toString('base64url')}`;
}

function devices() {
  return readJSON(DEVICES, []).filter(x => x && /^[0-9a-f]{64}$/i.test(x.token || ''));
}

export function getPushConfig() {
  return {
    native_enabled: APNS_READY,
    native_devices: devices().length,
    bark_fallback: Boolean(BARK_KEY),
    provider: APNS_READY ? 'apple' : (BARK_KEY ? 'bark' : 'none')
  };
}

export function registerPushDevice(input = {}) {
  const token = String(input.token || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('无效的 Apple 推送设备令牌');
  const current = devices().filter(x => x.token !== token);
  const item = {
    token,
    platform: String(input.platform || 'ios'),
    environment: input.environment === 'development' ? 'development' : 'production',
    bundle_id: String(input.bundle_id || APNS_BUNDLE_ID),
    updated_at: now()
  };
  current.push(item);
  writeJSON(DEVICES, current.slice(-20));
  return { ok: true, provider: 'apple', native_enabled: APNS_READY };
}

export function removePushDevice(tokenInput) {
  const token = String(tokenInput || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  const current = devices();
  const next = current.filter(x => x.token !== token);
  if (next.length !== current.length) writeJSON(DEVICES, next);
  return { ok: true, removed: current.length - next.length };
}

function apnsHost(environment) {
  return environment === 'development' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
}

function sendAPNsDevice(device, title, body, sound) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(apnsHost(device.environment));
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error('APNs 超时'));
    }, 15000);
    client.on('error', fail);
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${device.token}`,
      authorization: `bearer ${apnsJWT()}`,
      'content-type': 'application/json',
      'apns-topic': device.bundle_id || APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': '0'
    });
    let status = 0;
    let responseText = '';
    req.setEncoding('utf8');
    req.on('error', fail);
    req.on('response', headers => { status = Number(headers[':status'] || 0); });
    req.on('data', chunk => { responseText += chunk; });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.close();
      if (status === 200) return resolve({ ok: true, token: device.token });
      let reason = responseText;
      try { reason = JSON.parse(responseText).reason || responseText; } catch { /* 保留原文 */ }
      const error = new Error(`APNs ${status || '?'} ${reason || '推送失败'}`);
      error.status = status;
      error.token = device.token;
      reject(error);
    });
    req.end(JSON.stringify({
      aps: {
        alert: { title: String(title || ''), body: String(body || '') },
        sound: sound ? 'default' : undefined
      }
    }));
  });
}

async function sendApplePush(title, body, sound) {
  const list = devices();
  if (!APNS_READY || !list.length) return { ok: false, skipped: true, sent: 0 };
  const results = await Promise.allSettled(list.map(device => sendAPNsDevice(device, title, body, sound)));
  const failedTokens = [];
  let sent = 0;
  const errors = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') sent += 1;
    else {
      errors.push(String(result.reason?.message || result.reason));
      if ([400, 410].includes(Number(result.reason?.status))) failedTokens.push(list[index].token);
    }
  });
  if (failedTokens.length) writeJSON(DEVICES, list.filter(x => !failedTokens.includes(x.token)));
  if (sent) return { ok: true, provider: 'apple', sent, failed: errors.length };
  throw new Error(errors.join('; ') || 'APNs 没有可用设备');
}

async function sendBark(title, body, sound) {
  if (!BARK_KEY) throw new Error('没设置 BARK_KEY');
  let url = `https://api.day.app/${BARK_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`;
  if (sound) url += `?sound=${encodeURIComponent(sound)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Bark ${res.status} ${t}`.trim());
  }
  return { ok: true, provider: 'bark', sent: 1 };
}

export async function sendPush(title, body, sound) {
  let appleError = '';
  try {
    const native = await sendApplePush(title, body, sound);
    if (native.ok) {
      log({ title, body, sound: sound || '', provider: 'apple', ok: true, sent: native.sent, failed: native.failed || 0 });
      return native;
    }
  } catch (error) {
    appleError = String(error.message || error);
  }
  try {
    const fallback = await sendBark(title, body, sound);
    log({ title, body, sound: sound || '', provider: 'bark', fallback_from_apple: Boolean(appleError), ok: true });
    return fallback;
  } catch (error) {
    const parts = [appleError, String(error.message || error)].filter(Boolean);
    const message = parts.join('; ') || '没有可用的手机推送通道';
    log({ title, body, sound: sound || '', provider: APNS_READY ? 'apple' : 'none', ok: false, error: message });
    throw new Error(message);
  }
}
