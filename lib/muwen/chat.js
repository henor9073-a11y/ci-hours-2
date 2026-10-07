import fs from 'fs';
import path from 'path';
import { DATA_DIR, file, readJSON, writeJSON, newId, now, todayStr } from './common.js';
import * as album from './album.js';

// 木屋的聊天。棋子在网页上发，辞在他的 Code 窗口里收——
// GPD 上那个语音频道每几秒来取一次"还没送到的"（/api/chat/pending），送进辞的窗口之后回报"送到了"（=已读，两个勾）。
// 窗口没开着的时候消息就先存着，辞下次醒来用 chat_unread 照样能看到，跟以前的异步留言一样。
//
// 消息类型：text 文字 / voice 棋子录的语音（自动转文字给辞看）/ image 图片或表情包 / pat 拍一拍
// 另外每条都能：引用（reply_to）、分别收藏（stars.nor / stars.cy，互不覆盖）。

const FILE = file('chat.json');
const META_FILE = file('chat-meta.json');          // 两个人的状态文字 + 拍一拍库
const VOICE_DIR = path.join(DATA_DIR, 'chat-voice');
const IMAGE_DIR = path.join(DATA_DIR, 'chat-images');
for (const d of [VOICE_DIR, IMAGE_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

export const SENDERS = ['nor', 'cy', 'system'];
export const TYPES = ['text', 'voice', 'image', 'pat', 'call', 'system'];
export const MAX_VOICE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const VOICE_EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/aac': 'aac' };
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif' };
const NAME = { nor: '棋子', cy: '小辞', system: '系统' };

// chat.json 每次轮询都要读；跟年轮一样按修改时间缓存，文件没变就不重新解析
let cache = null;
function load() {
  let stamp = 'none';
  try { const st = fs.statSync(FILE); stamp = `${st.mtimeMs}:${st.size}`; } catch {}
  if (cache && cache.stamp === stamp) return cache.list;
  const d = readJSON(FILE, null);
  cache = { stamp, list: Array.isArray(d) ? d : [] };
  return cache.list;
}
function save(l) { writeJSON(FILE, l); cache = null; }

function view(m, viewer = '') {
  const { voice_file, image_file, ...rest } = m;
  if (viewer === 'cy') {
    const own = starMap(m).cy;
    delete rest.stars; delete rest.starred_by; delete rest.starred_at;
    if (own) { rest.stars = { cy: own }; rest.starred = true; rest.starred_at = own; }
    else delete rest.starred;
  }
  return { ...rest, has_voice: !!voice_file, has_image: !!(image_file || m.photo_id) };
}
// 引用的那一句，前端和辞那边都要看到原文片段，不用再去翻
function quoteOf(l, id) {
  if (!id) return null;
  const q = l.find(x => x.id === id);
  if (!q) return null;
  return { id: q.id, sender: q.sender, type: q.type, text: snippet(q) };
}
function snippet(m) {
  if (m.type === 'voice') return `[语音${m.duration ? ' ' + m.duration + '″' : ''}]${m.transcript ? ' ' + m.transcript : ''}`.slice(0, 80);
  if (m.type === 'image') return `[${m.sticker ? '表情' : '图片'}]${m.content ? ' ' + m.content : ''}`.slice(0, 80);
  if (m.type === 'pat') return patText(m);
  return String(m.content || '').replace(/\s+/g, ' ').slice(0, 80);
}
export function patText(m) {
  const target = m.sender === 'nor' ? NAME.cy : NAME.nor;
  return `${NAME[m.sender]} 拍了拍 ${target}${m.content || ''}`;
}
function withQuote(l, m, viewer = '') { const v = view(m, viewer); const q = quoteOf(l, m.reply_to); return q ? { ...v, quote: q } : v; }

export async function sendMessage({ sender, type = 'text', content = '', thinking = '', tools = [], reply_to = '', voice_base64 = '', voice_mime = '', duration = 0, voice_id = '', voice_stream = false, image_base64 = '', image_mime = '', photo_id = '', sticker = false, model = '' }) {
  if (!SENDERS.includes(sender)) throw new Error(`sender 必须是 ${SENDERS.join('/')}（nor=棋子，cy=辞）`);
  if (!TYPES.includes(type)) throw new Error(`type 必须是 ${TYPES.join('/')}`);
  const msg = {
    id: newId('m'), sender, type,
    content: String(content || ''),
    thinking: String(thinking || ''),
    tools: Array.isArray(tools) ? tools.map(t => ({ name: String(t.name || ''), result: String(t.result || '') })) : [],
    reply_to: String(reply_to || ''),
    at: now(), date: todayStr(),
    read: sender === 'system' // 系统动态不算任何一方的未读聊天
  };
  if (model) msg.model = String(model).slice(0, 60);
  // 辞的语音回复：文字在 content，voice_id 指向 ElevenLabs 生成的那段（跟 speak 同一个声音）
  if (voice_id) msg.voice_id = String(voice_id);
  if (voice_stream && sender === 'cy') msg.voice_stream = true;
  let voiceBuf = null;
  if (type === 'voice') {
    if (!voice_base64) throw new Error('语音消息要给 voice_base64');
    const mime = voice_mime || 'audio/webm';
    const ext = VOICE_EXT[mime] || 'webm';
    voiceBuf = Buffer.from(String(voice_base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!voiceBuf.length) throw new Error('语音数据解不出来');
    if (voiceBuf.length > MAX_VOICE_BYTES) throw new Error(`语音 ${(voiceBuf.length / 1048576).toFixed(1)}MB，超过 ${MAX_VOICE_BYTES / 1048576}MB 上限`);
    msg.voice_file = `${msg.id}.${ext}`;
    msg.voice_mime = mime;
    msg.duration = Number(duration) || 0;
    msg.bytes = voiceBuf.length;
    msg.transcript_status = 'pending';
    fs.writeFileSync(path.join(VOICE_DIR, msg.voice_file), voiceBuf);
  } else if (type === 'image') {
    if (photo_id) {
      // 相册里已有的图（表情包就是这么发的）：只存引用，不复制一份
      if (!album.getPhotoMeta(String(photo_id))) throw new Error('找不到这张相册图片');
      msg.photo_id = String(photo_id);
    } else {
      if (!image_base64) throw new Error('图片消息要给 image_base64 或 photo_id');
      // 新图片统一进图片资产库：原图保留，聊天只引用轻量预览，不再存第二份压缩图。
      const saved = await album.savePhoto({
        image_base64, mime_type: IMAGE_EXT[image_mime] ? image_mime : 'image/jpeg',
        caption: msg.content, tags: ['聊天图片'], visibility: 'chat'
      });
      msg.photo_id = saved.photo.id;
    }
    if (sticker) msg.sticker = true;
  } else if (type === 'pat') {
    // content 是拍一拍的后缀，比如"的脑袋说乖"；不给就是光拍一下
    msg.content = String(content || '').slice(0, 40);
  } else if (!msg.content.trim()) {
    throw new Error('文字消息不能是空的');
  }
  const l = load();
  l.push(msg);
  save(l);
  if (voiceBuf) transcribeLater(msg.id, voiceBuf, msg.voice_mime);
  // 辞的语音不阻塞 chat_reply：文字先到，服务器在后台提前生成并缓存。
  // 缓存好后前端轮询会拿到 voice_id，既能秒播，也能从 MP3 metadata 读到时长。
  if (voice_stream && sender === 'cy' && msg.content.trim()) synthesizeVoiceLater(msg.id, msg.content);
  return withQuote(l, msg);
}

// 辞或棋子在 App / MCP 里完成一个动作后，留一条居中的轻量动态。
// 它和聊天存在同一条时间线里，因此搜索、换设备和历史记录都不会丢。
export async function sendSystemEvent(content, action = '') {
  const message = await sendMessage({ sender: 'system', type: 'system', content });
  if (!action) return message;
  const l = load();
  const saved = l.find(x => x.id === message.id);
  if (saved) {
    saved.action = String(action).slice(0, 80);
    save(l);
    return withQuote(l, saved);
  }
  return message;
}

// 一通电话只在真正结束时写入一条聊天气泡。气泡归拨号的人，因此它和普通消息一样
// 会自然进入聊天时间线、历史记录和搜索。call_id 去重，避免状态轮询重复落库。
export function sendCallRecord(call) {
  if (!call?.id || !['nor', 'cy'].includes(call.caller)) return null;
  const l = load();
  const existed = l.find(m => m.type === 'call' && m.call_id === call.id);
  if (existed) return withQuote(l, existed);

  const accepted = Date.parse(call.accepted_at || '');
  const ended = Date.parse(call.ended_at || '');
  const connected = Number.isFinite(accepted) && Number.isFinite(ended) && ended >= accepted;
  const duration = connected ? Math.max(0, Math.round((ended - accepted) / 1000)) : 0;
  const mm = String(Math.floor(duration / 60)).padStart(2, '0');
  const ss = String(duration % 60).padStart(2, '0');
  const content = connected
    ? `通话时长 ${mm}:${ss}`
    : call.status === 'ended' && call.ended_by === call.caller ? '已挂断' : '未接通';

  const msg = {
    id: newId('m'), sender: call.caller, type: 'call', content,
    call_id: String(call.id), call_status: String(call.status || ''),
    call_duration: duration, call_ended_by: String(call.ended_by || ''),
    at: call.ended_at || now(), date: String(call.ended_at || now()).slice(0, 10),
    // 两个人刚共同经历了这通电话；它是记录，不应再被待送队列当成一条新留言唤醒辞。
    read: true
  };
  l.push(msg);
  save(l);
  return withQuote(l, msg);
}

// 图片先压一下再存：手机原图动辄 5MB，聊天里看不需要那么大
async function saveImage(b64, mime) {
  const m = IMAGE_EXT[mime] ? mime : 'image/jpeg';
  let buf = Buffer.from(String(b64).replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!buf.length) throw new Error('图片数据解不出来');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片 ${(buf.length / 1048576).toFixed(1)}MB，太大了`);
  let outMime = m, ext = IMAGE_EXT[m];
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(buf).metadata();
    const animated = (meta.pages || 1) > 1;
    // 动图原样留着（表情包很多是 gif）；其余超过 600KB 或者是 HEIC 的压成 jpeg/webp，最长边 1600
    if (!animated && (buf.length > 600 * 1024 || m === 'image/heic' || m === 'image/heif')) {
      const img = sharp(buf).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true });
      if (meta.hasAlpha) { buf = await img.webp({ quality: 80 }).toBuffer(); outMime = 'image/webp'; ext = 'webp'; }
      else { buf = await img.jpeg({ quality: 80, mozjpeg: true }).toBuffer(); outMime = 'image/jpeg'; ext = 'jpg'; }
    }
  } catch { /* 压不了就原样存 */ }
  const id = newId('ci');
  const image_file = `${id}.${ext}`;
  fs.writeFileSync(path.join(IMAGE_DIR, image_file), buf);
  return { image_file, image_mime: outMime, image_bytes: buf.length };
}

// 转文字在后台跑，不让发送等它。转完写回那条消息；频道那边会等转完（或者失败）再把语音送给辞。
function transcribeLater(id, buf, mime) {
  (async () => {
    let patch;
    try {
      const { transcribeAudio } = await import('../voice.js');
      const text = await transcribeAudio(buf, mime);
      patch = { transcript: text, transcript_status: text ? 'done' : 'empty' };
    } catch (e) {
      patch = { transcript_status: 'failed', transcript_error: String(e.message || e).slice(0, 200) };
    }
    const l = load();
    const m = l.find(x => x.id === id);
    if (m) { Object.assign(m, patch); save(l); }
  })();
}

function synthesizeVoiceLater(id, text) {
  (async () => {
    try {
      const { synthesizeSpeech } = await import('../voice.js');
      const voice = await synthesizeSpeech(text);
      const l = load(), m = l.find(x => x.id === id);
      if (m) { m.voice_id = voice.id; m.voice_cached_at = now(); save(l); }
    } catch (e) {
      // 流式端点仍可在用户点击时兜底；后台预生成失败不影响文字回复。
      console.warn('[chat voice cache]', String(e.message || e).slice(0, 180));
    }
  })();
}

// 分页：默认给最新的 limit 条；before=某条 id 就给它之前的 limit 条（往上翻）；since 给它之后的（轮询新消息）
function starMap(m) {
  if (m.stars && typeof m.stars === 'object') return { ...m.stars };
  if (!m.starred) return {};
  const old = String(m.starred_by || '');
  return old.includes('辞') || old === 'cy' ? { cy: m.starred_at || m.at } : { nor: m.starred_at || m.at };
}

export function getMessages({ since = '', before = '', limit = 200, unread_for = '', starred = false, starred_for = '', viewer = '' } = {}) {
  const all = load();
  let l = all;
  if (since) {
    const idx = l.findIndex(m => m.id === since);
    if (idx !== -1) l = l.slice(idx + 1);
    else l = l.filter(m => String(m.at) > String(since));
  }
  if (before) {
    const idx = l.findIndex(m => m.id === before);
    l = idx === -1 ? [] : l.slice(0, idx);
  }
  if (unread_for) l = l.filter(m => m.sender !== unread_for && !m.read);
  if (starred_for) l = l.filter(m => !!starMap(m)[starred_for]);
  else if (starred) l = l.filter(m => Object.keys(starMap(m)).length > 0);
  return l.slice(-limit).map(m => withQuote(all, m, viewer));
}

export function getMessage(id, viewer = '') {
  const l = load();
  const m = l.find(x => x.id === id);
  return m ? withQuote(l, m, viewer) : null;
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
  const all = load();
  const un = all.filter(m => m.sender !== who && !m.read);
  return {
    count: un.length,
    since: un.length ? un[0].at : null,
    messages: un.map(m => withQuote(all, m, who))
  };
}

// ---- 送进辞的窗口（GPD 上的语音频道来取）----
// 语音要等转完文字再送（最多等 45 秒，转不出来也送，告诉他有条语音）。
const TRANSCRIBE_WAIT_MS = 45000;
export function pendingForCy() {
  const all = load();
  const t = Date.now();
  const out = [];
  for (const m of all) {
    if (m.sender !== 'nor' || m.read || m.delivered_at) continue;
    if (m.type === 'voice' && m.transcript_status === 'pending' && t - Date.parse(m.at) < TRANSCRIBE_WAIT_MS) continue;
    out.push({ ...withQuote(all, m, 'cy'), text_for_cy: textForCy(m, all) });
  }
  return { count: out.length, messages: out };
}
// 给辞看的那一句：他那边只有文字，所以语音给转写、图片说清楚怎么看、拍一拍写成一句话
export function textForCy(m, all = load()) {
  const q = quoteOf(all, m.reply_to);
  const quote = q ? `（引用${q.sender === 'cy' ? '你' : '她自己'}那句：「${q.text}」）` : '';
  if (m.type === 'pat') return patText(m).replace(NAME.cy, '你');
  if (m.type === 'voice') {
    const body = m.transcript ? m.transcript : m.transcript_status === 'failed' ? '（转文字失败，听不到内容）' : '（没转出文字）';
    return `${quote}[语音 ${m.duration || '?'}″] ${body}`;
  }
  if (m.type === 'image') return `${quote}[${m.sticker ? '表情包' : '图片'}] ${m.content || ''}（用 chat_get_image 看，id=${m.id}）`.trim();
  return quote + (m.content || '');
}
// 送到辞窗口 = 他看到了，直接算已读
export function markDelivered(ids) {
  const set = new Set(ids || []);
  const l = load();
  let n = 0;
  for (const m of l) {
    if (!set.has(m.id) || m.sender !== 'nor') continue;
    if (!m.delivered_at) { m.delivered_at = now(); n++; }
    if (!m.read) { m.read = true; m.read_at = now(); }
  }
  if (n) save(l);
  return { delivered: n };
}

// ---- 辞那边的钩子补上真实的思考过程和工具调用 ----
// chat_reply 里辞自己填的 thinking 是他事后写的，不是原本的。GPD 上的 PostToolUse 钩子（hooks/chat-annotate.py）
// 在他调完 chat_reply 之后，从会话记录里把这一轮真正的 thinking 块和 tool_use 取出来，走这里覆盖上去。
export function annotate(id, { thinking, tools } = {}) {
  const l = load();
  const m = l.find(x => x.id === id && x.sender === 'cy');
  if (!m) return null;
  if (typeof thinking === 'string' && thinking.trim()) m.thinking = thinking.trim().slice(0, 20000);
  if (Array.isArray(tools)) m.tools = tools.filter(t => t && t.name).map(t => ({ name: String(t.name).slice(0, 120), result: String(t.result || '').slice(0, 400) })).slice(0, 40);
  m.annotated_at = now();
  save(l);
  return withQuote(l, m);
}

// ---- 搜索（木屋搜索页）：关键词逐条找，语音按转写找；点进去看上下文 ----
export function searchChat({ q, limit = 60, skip = 0 } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return { query: '', total: 0, hits: [] };
  const all = load();
  const textOf = m => m.type === 'voice' ? (m.transcript || '') : m.type === 'pat' ? patText(m) : (m.content || '');
  const matched = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]; const t = textOf(m);
    const idx = t.toLowerCase().indexOf(needle);
    if (idx === -1) continue;
    matched.push({ m, t, idx });
  }
  const hits = matched.slice(skip, skip + limit).map(({ m, t, idx }) => {
    const start = Math.max(0, idx - 24), end = Math.min(t.length, idx + needle.length + 60);
    return { id: m.id, sender: m.sender, type: m.type, at: m.at, date: m.date, starred: !!m.starred,
      before: (start > 0 ? '…' : '') + t.slice(start, idx), match: t.slice(idx, idx + needle.length), after: t.slice(idx + needle.length, end) + (end < t.length ? '…' : '') };
  });
  return { query: needle, total: matched.length, skip, shown: hits.length, hits };
}
export function contextOf(id, n = 8) {
  const all = load();
  const i = all.findIndex(m => m.id === id);
  if (i === -1) return null;
  const lo = Math.max(0, i - n), hi = Math.min(all.length, i + n + 1);
  return { id, messages: all.slice(lo, hi).map(m => withQuote(all, m)), has_before: lo > 0, has_after: hi < all.length };
}

// 聊天记录阅读器用的只读索引。这里直接按消息自己的 date 归档，避免为了翻某一天
// 把整个 chat.json 通过分页接口一页页拉回前端。
export function historyDates() {
  const dates = {};
  for (const m of load()) {
    const date = String(m.date || m.at || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    dates[date] = (dates[date] || 0) + 1;
  }
  const keys = Object.keys(dates).sort();
  return { first: keys[0] || null, last: keys[keys.length - 1] || null, dates };
}

export function historyDay(date) {
  const all = load();
  return all
    .filter(m => String(m.date || m.at || '').slice(0, 10) === date)
    .map(m => withQuote(all, m));
}

// ---- 收藏（两个人各自一份；一个人取消不会动另一个人的）----
export function setStar(id, on = true, by = '') {
  const l = load();
  const m = l.find(x => x.id === id);
  if (!m) return null;
  const owner = String(by).includes('辞') || by === 'cy' ? 'cy' : 'nor';
  const stars = starMap(m);
  if (on) stars[owner] = now(); else delete stars[owner];
  m.stars = stars;
  // 旧前端仍看 starred；新前端按 stars 分“我的收藏 / 辞的收藏”。
  m.starred = Object.keys(stars).length > 0;
  m.starred_at = stars[owner] || Object.values(stars)[0] || '';
  m.starred_by = Object.keys(stars).join(',');
  if (!m.starred) { delete m.starred; delete m.starred_at; delete m.starred_by; }
  save(l);
  return withQuote(l, m);
}

// ---- 状态文字 + 拍一拍库 ----
// 状态：棋子的只能从网页改，辞的只能从 MCP 改——两边都在各自的入口卡住，不靠自觉。
const DEFAULT_PATS = ['', '的脑袋', '的脸说乖', '的手', '说想你了', '说抱抱', '的尾巴', '说亲一个'];
function loadMeta() {
  const d = readJSON(META_FILE, null) || {};
  return { status: d.status || {}, pats: Array.isArray(d.pats) ? d.pats : DEFAULT_PATS.slice() };
}
export function getStatus() {
  const s = loadMeta().status;
  return { nor: s.nor || { text: '', at: '' }, cy: s.cy || { text: '', at: '' } };
}
export function setStatus(who, text) {
  if (!SENDERS.includes(who)) throw new Error(`who 必须是 ${SENDERS.join('/')}`);
  const d = loadMeta();
  d.status[who] = { text: String(text || '').trim().slice(0, 30), at: now() };
  writeJSON(META_FILE, d);
  return getStatus();
}
export function getPats() { return loadMeta().pats; }
export function setPats(list) {
  if (!Array.isArray(list)) throw new Error('拍一拍库要是一个数组');
  const clean = [...new Set(list.map(x => String(x == null ? '' : x).trim().slice(0, 30)))].slice(0, 50);
  const d = loadMeta();
  d.pats = clean;
  writeJSON(META_FILE, d);
  return clean;
}

export function voicePath(id) {
  const m = load().find(x => x.id === id);
  if (!m || !m.voice_file) return null;
  const p = path.join(VOICE_DIR, m.voice_file);
  return fs.existsSync(p) ? { path: p, mime: m.voice_mime || 'audio/webm' } : null;
}
// 图片消息的文件：自己存的在 chat-images，引用相册的交给调用方去相册拿
export function imageRef(id) {
  const m = load().find(x => x.id === id);
  if (!m || m.type !== 'image') return null;
  if (m.photo_id) return { photo_id: m.photo_id };
  const p = path.join(IMAGE_DIR, m.image_file || '');
  return m.image_file && fs.existsSync(p) ? { path: p, mime: m.image_mime || 'image/jpeg' } : null;
}
