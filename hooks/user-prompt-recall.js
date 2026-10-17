const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const T0 = Date.now();
const HOOK_DIR = path.join(os.homedir(), '.claude', 'hooks');
const LOG = path.join(HOOK_DIR, 'recall-debug.log');
const PENDING_DIR = path.join(HOOK_DIR, 'photo-recall-pending');
const RECENT_FILE = path.join(HOOK_DIR, 'photo-recall-recent.json');
const LOG_MAX = 2 * 1024 * 1024;
const RECENT_MS = 30 * 60 * 1000;

function log(message) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > LOG_MAX) fs.renameSync(LOG, `${LOG}.1`);
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

function statePath(sessionId) {
  const key = crypto.createHash('sha256').update(String(sessionId || 'unknown')).digest('hex').slice(0, 24);
  return path.join(PENDING_DIR, `${key}.json`);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

function clearPending(sessionId) {
  try { fs.unlinkSync(statePath(sessionId)); } catch {}
}

function chooseFreshPhotos(photos) {
  const cutoff = Date.now() - RECENT_MS;
  const recent = readJson(RECENT_FILE, {});
  for (const [id, at] of Object.entries(recent)) if (!Number(at) || Number(at) < cutoff) delete recent[id];
  const fresh = (Array.isArray(photos) ? photos : []).filter(photo => photo?.id && !recent[photo.id]).slice(0, 1);
  for (const photo of fresh) recent[photo.id] = Date.now();
  try { writeJsonAtomic(RECENT_FILE, recent); } catch {}
  return fresh;
}

function photoContext(photos) {
  if (!photos.length) return '';
  const lines = photos.map(photo => {
    const label = [photo.date, photo.caption, photo.reason].filter(Boolean).join('｜').replace(/\s+/g, ' ').slice(0, 260);
    return `- ${photo.id}${label ? `｜${label}` : ''}`;
  });
  return [
    '[muwen:photo-recall]',
    '本轮相关记忆还连着真实图片；图片此刻尚未进入你的视觉上下文。完成回答前，必须先对下面每个 id 调用 mcp__muwen__get_photo（默认预览图即可），亲眼看完再结合图片回答。不要只读编号或说明猜图，也不要把“稍后再看”当作已经看过。',
    ...lines
  ].join('\n');
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  let event;
  try { event = JSON.parse(input); } catch { process.exit(0); }
  const prompt = String(event.prompt || '');
  const sessionId = String(event.session_id || '');
  if (!prompt || prompt.startsWith('[muwen:')) process.exit(0);

  const url = process.env.MUWEN_URL || 'https://ci-hours-2.onrender.com';
  const token = process.env.MUWEN_TOKEN || '010219';
  try {
    const response = await fetch(`${url}/api/call/pending?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(1200) });
    const state = await response.json();
    const status = String(state.call?.status || state.call?.state || '').toLowerCase();
    if (state.call && !['ended', 'rejected', 'missed', 'cancelled', 'canceled', 'failed'].includes(status)) {
      clearPending(sessionId);
      log(`SKIP_CALL ${status || 'active'}`);
      process.exit(0);
    }
  } catch (error) { log(`CALL_CHECK ${error?.name || error?.message || error}`); }

  try {
    const response = await fetch(`${url}/api/recall?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ query: prompt, include_photos: true, photo_limit: 1 }),
      signal: AbortSignal.timeout(6500)
    });
    const result = await response.json();
    const photos = chooseFreshPhotos(result.photos);
    if (photos.length && sessionId) {
      writeJsonAtomic(statePath(sessionId), {
        session_id: sessionId,
        ids: photos.map(photo => photo.id),
        created_at: Date.now(),
        guard_attempts: 0
      });
    } else clearPending(sessionId);

    const output = [result.text || '', photoContext(photos)].filter(Boolean).join('\n');
    if (output) process.stdout.write(`${output}\n`);
    log(`DONE ${Date.now() - T0}ms ${String(result.text || '').length}chars count=${Number(result.count) || 0} photos=${photos.length} http=${response.status}`);
  } catch (error) {
    clearPending(sessionId);
    log(`ERR ${Date.now() - T0}ms ${error?.name || error?.code || error?.message || error}`);
  }
});
