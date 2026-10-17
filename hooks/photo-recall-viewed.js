const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PENDING_DIR = path.join(os.homedir(), '.claude', 'hooks', 'photo-recall-pending');
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
  const viewed = String(event.tool_input?.id || '');
  pending.ids = (pending.ids || []).filter(id => id !== viewed);
  try {
    if (!pending.ids.length) fs.unlinkSync(file);
    else fs.writeFileSync(file, JSON.stringify(pending));
  } catch {}
});
