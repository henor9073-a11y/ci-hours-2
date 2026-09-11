import fs from 'fs';
import path from 'path';
import { DATA_DIR, file, readJSON, writeJSON, newId, now, todayStr } from './common.js';

// 异步留言：棋子随时发，辞不在线；辞苏醒时检查未读并回复，棋子下次打开看到回复。
// 跟旧的"棋子想说"留言板（lib/messages.js）是两回事，那个是一次性留言，这个是对话流。
// 以后要改成实时聊天的话，这一层的形状不用动，只是推送方式变。

const FILE = file('chat.json');
const VOICE_DIR = path.join(DATA_DIR, 'chat-voice');
if (!fs.existsSync(VOICE_DIR)) fs.mkdirSync(VOICE_DIR, { recursive: true });

export const SENDERS = ['nor', 'cy'];
export const TYPES = ['text', 'voice'];
export const MAX_VOICE_BYTES = 8 * 1024 * 1024;
const VOICE_EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/aac': 'aac' };

function load() { const d = readJSON(FILE, null); return Array.isArray(d) ? d : []; }
function save(l) { writeJSON(FILE, l); }

function view(m) {
  const { voice_file, ...rest } = m;
  return { ...rest, has_voice: !!voice_file };
}

export function sendMessage({ sender, type = 'text', content = '', thinking = '', tools = [], reply_to = '', voice_base64 = '', voice_mime = '', duration = 0, voice_id = '' }) {
  if (!SENDERS.includes(sender)) throw new Error(`sender 必须是 ${SENDERS.join('/')}（nor=棋子，cy=辞）`);
  if (!TYPES.includes(type)) throw new Error(`type 必须是 ${TYPES.join('/')}`);
  const msg = {
    id: newId('m'), sender, type,
    content: String(content || ''),
    thinking: String(thinking || ''),
    tools: Array.isArray(tools) ? tools.map(t => ({ name: String(t.name || ''), result: String(t.result || '') })) : [],
    reply_to: String(reply_to || ''),
    at: now(), date: todayStr(),
    read: false            // 对方有没有看过
  };
  // 辞的语音回复：文字照旧存在 content 里，voice_id 指向 ElevenLabs 生成的那段音频
  // （存在 voice-history 里，跟 speak 同一个声音、同一个目录，木屋「语音记录」也能回放）。
  // 跟棋子录的语音不是一回事——她那种是上传的原始音频，走 voice_file。
  if (voice_id) msg.voice_id = String(voice_id);
  if (type === 'voice') {
    if (!voice_base64) throw new Error('语音消息要给 voice_base64');
    const mime = voice_mime || 'audio/webm';
    const ext = VOICE_EXT[mime] || 'webm';
    const buf = Buffer.from(String(voice_base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) throw new Error('语音数据解不出来');
    if (buf.length > MAX_VOICE_BYTES) throw new Error(`语音 ${(buf.length / 1048576).toFixed(1)}MB，超过 ${MAX_VOICE_BYTES / 1048576}MB 上限`);
    msg.voice_file = `${msg.id}.${ext}`;
    msg.voice_mime = mime;
    msg.duration = Number(duration) || 0;
    msg.bytes = buf.length;
    fs.writeFileSync(path.join(VOICE_DIR, msg.voice_file), buf);
  } else if (!msg.content.trim()) {
    throw new Error('文字消息不能是空的');
  }
  const l = load();
  l.push(msg);
  save(l);
  return view(msg);
}

// since 可以是消息 id 或 ISO 时间戳，只要它之后的
export function getMessages({ since = '', limit = 200, unread_for = '' } = {}) {
  let l = load();
  if (since) {
    const idx = l.findIndex(m => m.id === since);
    if (idx !== -1) l = l.slice(idx + 1);
    else l = l.filter(m => String(m.at) > String(since));
  }
  if (unread_for) l = l.filter(m => m.sender !== unread_for && !m.read);
  return l.slice(-limit).map(view);
}

// who 是"我是谁"：cy 标记的是棋子发来的那些
export function markRead(ids, who) {
  if (!SENDERS.includes(who)) throw new Error(`who 必须是 ${SENDERS.join('/')}`);
  const l = load();
  const set = ids && ids.length ? new Set(ids) : null;
  let n = 0;
  for (const m of l) {
    if (m.sender === who) continue;              // 自己发的不用标
    if (set && !set.has(m.id)) continue;
    if (!m.read) { m.read = true; m.read_at = now(); n++; }
  }
  if (n) save(l);
  return { marked: n, who };
}

export function unreadCount(who) {
  return load().filter(m => m.sender !== who && !m.read).length;
}

// 给辞的苏醒流程用：有没有新留言、都说了什么
export function unreadSummary(who = 'cy') {
  const un = load().filter(m => m.sender !== who && !m.read);
  return {
    count: un.length,
    since: un.length ? un[0].at : null,
    messages: un.map(view)
  };
}

export function voicePath(id) {
  const m = load().find(x => x.id === id);
  if (!m || !m.voice_file) return null;
  const p = path.join(VOICE_DIR, m.voice_file);
  return fs.existsSync(p) ? { path: p, mime: m.voice_mime || 'audio/webm' } : null;
}
