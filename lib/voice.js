import fs from 'fs';
import path from 'path';
import { now } from './muwen/common.js';

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
// 留成环境变量是因为各代模型对 voice_settings 的接受范围不同（见下面的模型适配），
// 万一线上表现不对，Render 上改 ELEVENLABS_MODEL_ID 就能切回去，不用重新部署代码。
// 留言与通话分开选模型；留言默认使用 v4，仍可在 Render 单独覆盖。
const MODEL_ID = process.env.ELEVENLABS_MESSAGE_MODEL_ID || 'eleven_v4';
const LEGACY_CALL_MODEL = process.env.ELEVENLABS_MODEL_ID;
// 实时通话优先用显式配置；否则兼容原来的 ELEVENLABS_MODEL_ID。
const CALL_MODEL_ID = process.env.ELEVENLABS_CALL_MODEL_ID || LEGACY_CALL_MODEL || (MODEL_ID === 'eleven_v4' ? 'eleven_v4_turbo' : MODEL_ID);

// 真正调 ElevenLabs 把文字变成声音，这一步现在整个搬到服务端来了——
// 之前是网页自己拿 key 调，现在 key 只在 Render 上，网页不用管这些了。
// 生成完直接存进磁盘 + 记一条历史，这样棋子随时能回放，不会因为网页没开着错过。
// v4 只支持 Stability / Similarity；把旧的 style、speed 传进去会 422。
// 棋子希望辞更有变化，所以稳定性固定为 0.3。
function settingsFor(model) {
  if (String(model).startsWith('eleven_v4')) return { stability: 0.3, similarity_boost: 0.5 };
  if (model === 'eleven_v3') return { stability: 0.3 };
  return { stability: 0.3, similarity_boost: 0.5, style: 0, speed: 0.73 };
}
function languageFor(text) {
  const s = String(text || '');
  const kana = /[\u3040-\u30ff]/.test(s), hangul = /[\uac00-\ud7af]/.test(s);
  const han = /[\u3400-\u9fff]/.test(s), latin = /[A-Za-z]/.test(s);
  // v4 本身支持多语言：一句里混有英文与中/日文时不要强锁语言，让模型保留自然 code-switch。
  if (kana) return latin ? undefined : 'ja';
  if (hangul) return latin || han ? undefined : 'ko';
  if (han) return latin ? undefined : 'zh';
  if (latin) return 'en';
  return undefined;
}

async function callEleven(text, settings, model = MODEL_ID) {
  const language_code = languageFor(text);
  return fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: 'POST',
    headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: model, ...(language_code ? { language_code } : {}), ...(settings ? { voice_settings: settings } : {}) }),
    // 第三方偶尔不回包时不能把 chat_reply 一直吊住；超时后上层会照常发送文字。
    signal: AbortSignal.timeout(20000)
  });
}

// 通话使用 HTTP chunked streaming：上游每来一块就立刻写给浏览器，不等整段 MP3 生成完。
export async function streamSpeech(text, res) {
  if (!API_KEY || !VOICE_ID) throw new Error('没配置 ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID');
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?output_format=mp3_44100_128`;
  const language_code = languageFor(text);
  const request = settings => fetch(url, {
    method: 'POST', headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: String(text), model_id: CALL_MODEL_ID, ...(language_code ? { language_code } : {}), ...(settings ? { voice_settings: settings } : {}) }),
    signal: AbortSignal.timeout(60000)
  });
  let up = await request(settingsFor(CALL_MODEL_ID));
  if (!up.ok && up.status >= 400 && up.status < 500) {
    const first = await up.text().catch(() => '');
    if (/voice_settings|stability|speed|similarity|style/i.test(first)) up = await request(null);
    else throw new Error(`ElevenLabs 流式生成失败：${up.status} ${first.slice(0, 160)}`);
  }
  if (!up.ok) throw new Error(`ElevenLabs 流式生成失败：${up.status} ${(await up.text().catch(() => '')).slice(0, 160)}`);
  res.status(200); res.setHeader('Content-Type', 'audio/mpeg'); res.setHeader('Cache-Control', 'no-store');
  const reader = up.body.getReader();
  try { while (true) { const { done, value } = await reader.read(); if (done) break; if (!res.write(Buffer.from(value))) await new Promise(ok => res.once('drain', ok)); } }
  finally { res.end(); }
}

export async function synthesizeSpeech(text) {
  if (!API_KEY || !VOICE_ID) throw new Error('没配置 ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID');
  let res = await callEleven(text, settingsFor(MODEL_ID));
  // v3 对 voice_settings 的接受范围跟 v2 不一样（比如 stability 只收几个固定档、speed 未必支持）。
  // 被挑参数的时候退一步用模型默认音色重试一次——宁可音色差一点，也好过整条说不出来。
  if (!res.ok && res.status >= 400 && res.status < 500) {
    const first = await res.text().catch(() => '');
    if (/voice_settings|stability|speed|similarity/i.test(first)) {
      console.warn(`[voice] ${MODEL_ID} 不接受这组 voice_settings，改用模型默认重试：${first.slice(0, 200)}`);
      res = await callEleven(text, null, MODEL_ID);
    } else {
      throw new Error(`ElevenLabs 生成失败：${res.status} ${first}`);
    }
  }
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`ElevenLabs 生成失败（${MODEL_ID}）：${res.status} ${msg}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const id = newId();
  const filename = `${id}.mp3`;
  fs.writeFileSync(path.join(VOICE_DIR, filename), buf);

  const history = readJSON(HISTORY_FILE, []);
  const entry = { id, text, filename, createdAt: now() };
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

// ---- 语音转文字（棋子在木屋录的语音）----
// 辞那边只看得到文字，听不见音频——不转的话她发的语音对他就是一条空消息。
// 用 ElevenLabs 的 Scribe，跟 speak 同一把 key，不用另外开服务。
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v2';
export async function transcribeAudio(buf, mime = 'audio/webm') {
  if (!API_KEY) throw new Error('没配置 ELEVENLABS_API_KEY');
  const form = new FormData();
  form.append('model_id', STT_MODEL);
  if (STT_MODEL === 'scribe_v2') form.append('language_code', 'zh');
  form.append('tag_audio_events', 'false');
  form.append('diarize', 'false');
  form.append('num_speakers', '1');
  form.append('file', new Blob([buf], { type: mime }), 'voice.' + (mime.split('/')[1] || 'webm'));
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST', headers: { 'xi-api-key': API_KEY }, body: form,
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error(`转文字失败：${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = await res.json();
  return String(j.text || '').trim();
}
