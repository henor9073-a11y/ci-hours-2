const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PENDING_DIR = path.join(os.homedir(), '.claude', 'hooks', 'photo-recall-pending');
const MAX_AGE_MS = 30 * 60 * 1000;
function statePath(sessionId) {
  const key = crypto.createHash('sha256').update(String(sessionId || 'unknown')).digest('hex').slice(0, 24);
  return path.join(PENDING_DIR, `${key}.json`);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let event;
  try { event = JSON.parse(input); } catch { return; }
  const file = statePath(event.session_id);
  let pending;
  try { pending = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  const ids = Array.isArray(pending.ids) ? pending.ids.filter(Boolean) : [];
  const stale = !Number(pending.created_at) || Date.now() - Number(pending.created_at) > MAX_AGE_MS;
  if (!ids.length || stale) {
    try { fs.unlinkSync(file); } catch {}
    return;
  }

  // 只强制续回一次，避免工具临时断线时把会话锁进循环。通常首次注入就会在回答前看图，
  // 这里是防止它漏看；若工具真的不可用，下一次 Stop 会放行并清掉这条临时状态。
  if (Number(pending.guard_attempts) >= 1 || event.stop_hook_active) {
    try { fs.unlinkSync(file); } catch {}
    return;
  }
  pending.guard_attempts = Number(pending.guard_attempts || 0) + 1;
  try { fs.writeFileSync(file, JSON.stringify(pending)); } catch {}
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `本轮自动召回的相关图片还没有真正进入视觉上下文。请现在先调用 mcp__muwen__get_photo 查看预览图（id: ${ids.join(', ')}），看完后再完成或修正回答。不要只根据图片编号或文字说明猜测。`
  }));
});
