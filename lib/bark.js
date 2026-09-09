// Bark 推送——api.day.app 是公网服务，Render 服务器直接就能调，一次请求就发完。
// 单独抽成一个文件是因为现在不止 mcp.js 的 send_push/speak 用它了，
// 日程模块的定时检查（server.js 里的 cron）也要直接推，不经过 MCP 那条路。
import { file, readJSON, writeJSON, newId, now, todayStr } from './muwen/common.js';

const BARK_KEY = process.env.BARK_KEY;
const LOG = file('push-log.json');
const KEEP = 300;

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

export async function sendPush(title, body, sound) {
  if (!BARK_KEY) { log({ title, body, sound: sound || '', ok: false, error: '没设置 BARK_KEY' }); throw new Error('服务器没设置 BARK_KEY 环境变量，先在 Render 里加一个'); }
  let url = `https://api.day.app/${BARK_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`;
  if (sound) url += `?sound=${encodeURIComponent(sound)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      log({ title, body, sound: sound || '', ok: false, error: `${res.status} ${t}`.trim() });
      throw new Error(`Bark 推送失败：${res.status} ${t}`);
    }
    log({ title, body, sound: sound || '', ok: true });
    return { ok: true };
  } catch (e) {
    if (!String(e.message).startsWith('Bark 推送失败')) log({ title, body, sound: sound || '', ok: false, error: String(e.message || e) });
    throw e;
  }
}
