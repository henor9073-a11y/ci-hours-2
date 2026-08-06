import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';
const VOICE_DIR = path.join(DATA_DIR, 'voices');
const HISTORY_FILE = path.join(DATA_DIR, 'voice-history.json');

if (!fs.existsSync(VOICE_DIR)) fs.mkdirSync(VOICE_DIR, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function newId() { return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

const API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const MODEL_ID = 'eleven_multilingual_v2';

// 真正调 ElevenLabs 把文字变成声音，这一步现在整个搬到服务端来了——
// 之前是网页自己拿 key 调，现在 key 只在 Render 上，网页不用管这些了。
// 生成完直接存进磁盘 + 记一条历史，这样棋子随时能回放，不会因为网页没开着错过。
export async function synthesizeSpeech(text) {
  if (!API_KEY || !VOICE_ID) throw new Error('没配置 ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID');
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: 'POST',
    headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`ElevenLabs 生成失败：${res.status} ${msg}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const id = newId();
  const filename = `${id}.mp3`;
  fs.writeFileSync(path.join(VOICE_DIR, filename), buf);

  const history = readJSON(HISTORY_FILE, []);
  const entry = { id, text, filename, createdAt: new Date().toISOString() };
  history.push(entry);
  writeJSON(HISTORY_FILE, history.slice(-200)); // 留最近 200 条，别无限增长
  return entry;
}

export function getVoiceHistory(limit = 50) {
  const history = readJSON(HISTORY_FILE, []);
  return history.slice(-limit).reverse().map(({ id, text, createdAt }) => ({ id, text, createdAt }));
}

export function getVoiceFilePath(id) {
  const history = readJSON(HISTORY_FILE, []);
  const entry = history.find(x => x.id === id);
  if (!entry) return null;
  const p = path.join(VOICE_DIR, entry.filename);
  return fs.existsSync(p) ? p : null;
}
