import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';
const SPEECH_FILE = path.join(DATA_DIR, 'speech.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function newId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ---- 语音队列：辞想说话的时候把文字存进来，棋子电脑上跑着的本地播放器来取 ----
// 只保留最新一条待播的——参考 StackChan 方案里"latest-only"的思路：
// 如果本地播放器掉线了一段时间，不需要把攒下的话全部念一遍，只念最新这句就够了，
// 不然会出现"辞在追着念半小时前说过的话"这种怪事。
export function enqueueSpeech(text) {
  const q = readJSON(SPEECH_FILE, []);
  for (const item of q) if (item.status === 'pending') item.status = 'skipped';
  const entry = { id: newId(), text, status: 'pending', createdAt: new Date().toISOString() };
  q.push(entry);
  writeJSON(SPEECH_FILE, q.slice(-50)); // 别无限增长，只留最近 50 条历史
  return entry;
}

export function getPendingSpeech() {
  const q = readJSON(SPEECH_FILE, []);
  return q.find(x => x.status === 'pending') || null;
}

export function markSpeechDone(id) {
  const q = readJSON(SPEECH_FILE, []);
  const x = q.find(i => i.id === id);
  if (!x) return null;
  x.status = 'done';
  x.doneAt = new Date().toISOString();
  writeJSON(SPEECH_FILE, q);
  return x;
}
