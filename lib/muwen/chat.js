import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { DATA_DIR, file, readJSON, writeJSON, newId, now, todayStr } from './common.js';
import * as album from './album.js';
import { recordChatMessage, recordDelivery } from './continuity.js';
import { generateStructured } from './structured-llm.js';

// 木屋的聊天。棋子在网页上发，辞在他的 Code 窗口里收——
// GPD 上那个语音频道每几秒来取一次"还没送到的"（/api/chat/pending），送进辞的窗口之后回报"送到了"（=已读，两个勾）。
// 窗口没开着的时候消息就先存着，辞下次醒来用 chat_unread 照样能看到，跟以前的异步留言一样。
//
// 消息标准（v2）：每条记录都用同一组核心字段表达发送者、类型、正文、媒体、
// 转写、投递状态、来源设备、时间、回复关系和流式播放状态。旧字段继续保留，
// 读取旧 chat.json 时由 view() 动态补齐，因此不需要一次性重写历史记录。

const FILE = file('chat.json');
const META_FILE = file('chat-meta.json');          // 两个人的状态文字 + 拍一拍库
const VOICE_DIR = path.join(DATA_DIR, 'chat-voice');
const IMAGE_DIR = path.join(DATA_DIR, 'chat-images');
for (const d of [VOICE_DIR, IMAGE_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

export const SENDERS = ['nor', 'cy', 'system'];
export const TYPES = ['text', 'voice', 'call', 'watch', 'inject', 'image', 'pat', 'system', 'claude_mirror'];
export const MAX_VOICE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGE_BATCH_BYTES = 50 * 1024 * 1024;
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

function inferredDevice(m) {
  if (m.source_device) return String(m.source_device);
  if (m.kind === 'call' || m.type === 'call') return 'call';
  if (m.sender === 'cy') return 'claude_code';
  if (m.sender === 'system') return 'muwu_backend';
  return 'legacy_unknown';
}

function inferredSendStatus(m) {
  if (m.send_status === 'failed') return 'failed';
  if (m.read) return 'read';
  if (m.delivered_at) return 'delivered';
  return 'sent';
}

function inferredStreamingState(m) {
  if (m.streaming_playback_state) return String(m.streaming_playback_state);
  if (m.voice_stream && !m.voice_id) return 'pending';
  if (m.voice_stream || m.voice_id || m.voice_file) return 'ready';
  return 'none';
}

function inferredAttachments(m) {
  if (Array.isArray(m.media_attachments)) return m.media_attachments;
  const out = [];
  if (m.voice_file || m.voice_id || m.voice_stream) {
    out.push({
      kind: 'audio', mime: m.voice_mime || 'audio/mpeg',
      duration: Number(m.voice_duration ?? m.duration) || 0,
      bytes: Number(m.voice_bytes ?? m.bytes) || 0,
      filename: m.voice_filename || null,
      voice_id: m.voice_id || null, streamed: !!m.voice_stream
    });
  }
  const photoIDs = Array.isArray(m.photo_ids) && m.photo_ids.length
    ? m.photo_ids
    : (m.photo_id ? [m.photo_id] : []);
  if (m.image_file || photoIDs.length) {
    if (photoIDs.length) {
      for (const photoID of photoIDs) {
        out.push({
          kind: 'image', mime: m.image_mime || null,
          photo_id: photoID || null, sticker: !!m.sticker
        });
      }
    } else {
      out.push({
        kind: 'image', mime: m.image_mime || null,
        photo_id: null, sticker: !!m.sticker
      });
    }
  }
  return out;
}

function canonicalFields(m) {
  const kind = TYPES.includes(m.kind) ? m.kind : TYPES.includes(m.type) ? m.type : 'text';
  const createdAt = String(m.created_at || m.at || '');
  return {
    message_id: String(m.message_id || m.id || ''),
    sender: SENDERS.includes(m.sender) ? m.sender : 'system',
    kind,
    content: String(m.content || ''),
    media_attachments: inferredAttachments(m),
    voice_duration: Number(m.voice_duration ?? m.duration) || 0,
    transcript: String(m.transcript || ''),
    send_status: inferredSendStatus(m),
    source_device: inferredDevice(m),
    created_at: createdAt,
    reply_to: String(m.reply_to || ''),
    streaming_playback_state: inferredStreamingState(m)
  };
}

function applyCanonicalFields(m) {
  Object.assign(m, canonicalFields(m));
  return m;
}

function view(m, viewer = '') {
  const { voice_file, image_file, ...rest } = m;
  if (viewer === 'cy') {
    const own = starMap(m).cy;
    delete rest.stars; delete rest.starred_by; delete rest.starred_at;
    if (own) { rest.stars = { cy: own }; rest.starred = true; rest.starred_at = own; }
    else delete rest.starred;
  }
  return {
    ...rest, ...canonicalFields(m),
    has_voice: !!voice_file,
    has_image: !!(image_file || m.photo_id || (Array.isArray(m.photo_ids) && m.photo_ids.length))
  };
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
  if (m.type === 'image') {
    const count = Array.isArray(m.photo_ids) && m.photo_ids.length ? m.photo_ids.length : 1;
    const label = m.sticker ? '表情' : (count > 1 ? `${count}张图片` : '图片');
    return `[${label}]${m.content ? ' ' + m.content : ''}`.slice(0, 80);
  }
  if (m.type === 'pat') return patText(m);
  return String(m.content || '').replace(/\s+/g, ' ').slice(0, 80);
}
export function patText(m) {
  const target = m.sender === 'nor' ? NAME.cy : NAME.nor;
  return `${NAME[m.sender]} 拍了拍 ${target}${m.content || ''}`;
}
function withQuote(l, m, viewer = '') { const v = view(m, viewer); const q = quoteOf(l, m.reply_to); return q ? { ...v, quote: q } : v; }

export async function sendMessage({ sender, type = 'text', kind = '', content = '', thinking = '', tools = [], reply_to = '', voice_base64 = '', voice_mime = '', duration = 0, voice_id = '', voice_stream = false, image_base64 = '', image_mime = '', images = [], photo_id = '', photo_ids = [], sticker = false, model = '', source_device = '', client_message_id = '', mirror_key = '', session_id = '', mirror_only = false, dedupe_window_ms = 0 }) {
  if (!SENDERS.includes(sender)) throw new Error(`sender 必须是 ${SENDERS.join('/')}（nor=棋子，cy=辞）`);
  if (kind) type = kind;
  if (!TYPES.includes(type)) throw new Error(`type 必须是 ${TYPES.join('/')}`);
  const clientID = String(client_message_id || '').trim().slice(0, 120);
  const mirrorKey = String(mirror_key || '').trim().slice(0, 160);
  const existed = load().find(m => (clientID && m.sender === sender && m.client_message_id === clientID)
    || (mirrorKey && m.sender === sender && m.mirror_key === mirrorKey));
  if (existed) return withQuote(load(), existed);
  // MCP 的语音回复偶尔会在已经成功后被模型再次调用。只有调用方明确给出
  // 去重窗口时才挡住完全相同的语音，避免影响普通文字或用户有意重复发送。
  const dedupeWindowMs = Math.max(0, Math.min(Number(dedupe_window_ms) || 0, 10 * 60 * 1000));
  if (dedupeWindowMs && voice_stream && sender === 'cy') {
    const normalized = String(content || '').trim().replace(/\s+/g, ' ');
    const replyTo = String(reply_to || '');
    const cutoff = Date.now() - dedupeWindowMs;
    const duplicate = load().slice().reverse().find(m => m.sender === sender
      && m.type === type
      && !!m.voice_stream
      && String(m.content || '').trim().replace(/\s+/g, ' ') === normalized
      && String(m.reply_to || '') === replyTo
      && Date.parse(m.at || 0) >= cutoff);
    if (duplicate) return withQuote(load(), duplicate);
  }
  const msg = {
    id: newId('m'), sender, type, kind: type,
    content: String(content || ''),
    thinking: String(thinking || ''),
    tools: Array.isArray(tools) ? tools.map(t => ({
      name: String(t.name || ''),
      input: String(t.input || '').slice(0, 3000),
      result: String(t.result || '').slice(0, 6000)
    })) : [],
    reply_to: String(reply_to || ''),
    at: now(), date: todayStr(), source_device: String(source_device || inferredDevice({ sender, type })),
    read: sender === 'system' // 系统动态不算任何一方的未读聊天
  };
  if (clientID) msg.client_message_id = clientID;
  if (mirrorKey) msg.mirror_key = mirrorKey;
  if (session_id) msg.session_id = String(session_id).slice(0, 120);
  if (mirror_only || type === 'claude_mirror') msg.mirror_only = true;
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
    const groupedImages = Array.isArray(images) ? images.slice(0, 10) : [];
    const groupedPhotoIDs = Array.isArray(photo_ids)
      ? photo_ids.map(x => String(x || '').trim()).filter(Boolean).slice(0, 10)
      : [];
    if ((Array.isArray(images) && images.length > 10) || (Array.isArray(photo_ids) && photo_ids.length > 10)) {
      throw new Error('一条消息最多 10 张图片');
    }
    if (groupedPhotoIDs.length) {
      for (const id of groupedPhotoIDs) {
        if (!album.getPhotoMeta(id)) throw new Error(`找不到这张相册图片：${id}`);
      }
      msg.photo_ids = groupedPhotoIDs;
      msg.photo_id = groupedPhotoIDs[0];
    } else if (groupedImages.length) {
      const savedIDs = [];
      let batchBytes = 0;
      for (const image of groupedImages) {
        const data = String(image && image.image_base64 || '');
        if (!data) throw new Error('图片组里有空图片');
        const decodedBytes = Buffer.from(data.replace(/^data:[^;]+;base64,/, ''), 'base64').length;
        if (!decodedBytes) throw new Error('图片组里有图片解不出来');
        if (decodedBytes > MAX_IMAGE_BYTES) throw new Error(`单张图片超过 ${MAX_IMAGE_BYTES / 1048576}MB 上限`);
        batchBytes += decodedBytes;
        if (batchBytes > MAX_IMAGE_BATCH_BYTES) throw new Error(`这组图片超过 ${MAX_IMAGE_BATCH_BYTES / 1048576}MB 上限`);
        const mime = String(image && image.image_mime || 'image/jpeg');
        const saved = await album.savePhoto({
          image_base64: data, mime_type: IMAGE_EXT[mime] ? mime : 'image/jpeg',
          caption: msg.content, tags: ['聊天图片'], visibility: 'chat'
        });
        savedIDs.push(saved.photo.id);
      }
      msg.photo_ids = savedIDs;
      msg.photo_id = savedIDs[0];
    } else if (photo_id) {
      // 相册里已有的图（表情包就是这么发的）：只存引用，不复制一份
      if (!album.getPhotoMeta(String(photo_id))) throw new Error('找不到这张相册图片');
      msg.photo_id = String(photo_id);
      msg.photo_ids = [msg.photo_id];
    } else {
      if (!image_base64) throw new Error('图片消息要给 image_base64 或 photo_id');
      // 新图片统一进图片资产库：原图保留，聊天只引用轻量预览，不再存第二份压缩图。
      const saved = await album.savePhoto({
        image_base64, mime_type: IMAGE_EXT[image_mime] ? image_mime : 'image/jpeg',
        caption: msg.content, tags: ['聊天图片'], visibility: 'chat'
      });
      msg.photo_id = saved.photo.id;
      msg.photo_ids = [msg.photo_id];
    }
    if (sticker) msg.sticker = true;
  } else if (type === 'pat') {
    // content 是拍一拍的后缀，比如"的脑袋说乖"；不给就是光拍一下
    msg.content = String(content || '').slice(0, 40);
  } else if (!msg.content.trim()) {
    throw new Error('文字消息不能是空的');
  }
  applyCanonicalFields(msg);
  const l = load();
  // 图片上传等步骤会 await；若客户端在等待期间因网络超时用同一个请求号重试，
  // 以先落库的那条为准，避免生成两条完全相同的聊天消息。
  const raced = l.find(m => (clientID && m.sender === sender && m.client_message_id === clientID)
    || (mirrorKey && m.type === 'claude_mirror' && m.mirror_key === mirrorKey));
  if (raced) return withQuote(l, raced);
  l.push(msg);
  save(l);
  // 连续性日志不能影响聊天主链路；磁盘或日志故障只留在服务端错误流里。
  try { recordChatMessage(msg); } catch (error) { console.error('continuity chat log failed:', error?.message || error); }
  if (voiceBuf) transcribeLater(msg.id, voiceBuf, msg.voice_mime);
  // 辞的语音不阻塞 chat_reply：文字先到，服务器在后台提前生成并缓存。
  // 缓存好后前端轮询会拿到 voice_id，既能秒播，也能从 MP3 metadata 读到时长。
  if (voice_stream && sender === 'cy' && msg.content.trim()) synthesizeVoiceLater(msg.id);
  return withQuote(l, msg);
}

// 辞或棋子在 App / MCP 里完成一个动作后，留一条居中的轻量动态。
// 它和聊天存在同一条时间线里，因此搜索、换设备和历史记录都不会丢。
export async function sendSystemEvent(content, action = '', options = {}) {
  const explicitDeliveryKey = String(options.deliveryKey || '').slice(0, 120);
  const deliveryKey = String(options.deliveryKey || action || '').slice(0, 120);
  // 后台桥接可能已经把消息写进木屋，但在 ACK 返回前断线。重试时按稳定的
  // deliveryKey 找回原消息，绝不能再生成第二条。
  if (explicitDeliveryKey) {
    const all = load();
    const existing = all.find(message => message.sender === 'system' && message.delivery_key === explicitDeliveryKey);
    if (existing) return withQuote(all, existing);
  }
  const message = await sendMessage({
    sender: 'system', type: 'system', content,
    source_device: String(options.sourceDevice || 'muwu_backend').slice(0, 80)
  });
  const l = load();
  const saved = l.find(x => x.id === message.id);
  if (saved) {
    if (action) saved.action = String(action).slice(0, 80);
    // 普通系统动态只显示在木屋时间线；明确要求 deliverToCy 的动态才进入
    // 当前主要窗口的待投递队列，避免所有后台噪音一起唤醒辞。
    if (options.deliverToCy) {
      saved.deliver_to_cy = true;
      saved.delivery_key = deliveryKey || undefined;
      if (options.deliveryText) saved.delivery_text = String(options.deliveryText).slice(0, 500);
      saved.read = false;
      delete saved.read_at;
    }
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
    id: newId('m'), sender: call.caller, type: 'call', kind: 'call', content,
    call_id: String(call.id), call_status: String(call.status || ''),
    call_duration: duration, call_ended_by: String(call.ended_by || ''),
    at: call.ended_at || now(), date: String(call.ended_at || now()).slice(0, 10),
    // 两个人刚共同经历了这通电话；它是记录，不应再被待送队列当成一条新留言唤醒辞。
    read: true, source_device: 'call'
  };
  applyCanonicalFields(msg);
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
    if (m) {
      Object.assign(m, patch);
      applyCanonicalFields(m);
      save(l);
    }
  })();
}

const translationJobs = new Map();

function voiceTranslationSource(message) {
  if (!message || message.sender !== 'cy') return '';
  const hasVoice = message.type === 'voice' || message.voice_stream || message.voice_id || message.voice_file;
  if (!hasVoice) return '';
  return String(message.type === 'voice' ? message.transcript || '' : message.content || '').trim();
}

function translationSourceHash(source) {
  return createHash('sha256').update(source).digest('hex');
}

// 翻译只在棋子主动点按钮时发生。结果写回原消息，因此网页和 Sigh 共用同一份缓存；
// 原文有变化时 hash 会失效并重新翻，展开/收起则完全不产生新调用。
export async function translateMessage(id, { generate = generateStructured } = {}) {
  const messageID = String(id || '').trim();
  const original = load().find(message => message.id === messageID);
  if (!original) throw new Error('找不到这条语音');
  const source = voiceTranslationSource(original);
  if (!source) throw new Error('这条辞的语音还没有可翻译的文字');
  const sourceHash = translationSourceHash(source);
  if (original.translation_zh && original.translation_source_hash === sourceHash) {
    return withQuote(load(), original);
  }
  if (translationJobs.has(messageID)) return translationJobs.get(messageID);

  const job = (async () => {
    const result = await generate({
      system: `你是忠实的语音转写翻译器。把输入完整翻译成自然、准确的简体中文。保留人名、段落、停顿、语气、拟声词和原意；方括号里的语气或动作说明也翻译，但保留方括号。不要解释、总结、删减或续写。`,
      user: source.slice(0, 12000),
      schema: {
        type: 'object', additionalProperties: false,
        properties: { translation: { type: 'string' } }, required: ['translation']
      },
      maxTokens: 2400, timeoutMs: 25000, effort: 'low'
    });
    const translation = String(result?.data?.translation || '').trim();
    if (!translation) throw new Error('没有生成译文');
    const messages = load();
    const current = messages.find(message => message.id === messageID);
    if (!current) throw new Error('翻译完成，但原消息已经不在了');
    // 原文若在请求期间发生变化，不把旧译文贴到新原文下面。
    if (translationSourceHash(voiceTranslationSource(current)) !== sourceHash) {
      throw new Error('原文刚刚更新了，请再点一次翻译');
    }
    current.translation_zh = translation;
    current.translation_source_hash = sourceHash;
    current.translation_status = 'done';
    current.translation_at = now();
    current.translation_provider = String(result?.provider || '').slice(0, 40);
    current.translation_model = String(result?.model || '').slice(0, 80);
    save(messages);
    return withQuote(messages, current);
  })();
  translationJobs.set(messageID, job);
  try { return await job; }
  finally { translationJobs.delete(messageID); }
}

const voiceCacheJobs = new Map();

export async function ensureVoiceCached(id) {
  const existing = getMessage(id);
  if (!existing || existing.sender !== 'cy' || !existing.voice_stream || !existing.content) {
    throw new Error('找不到这条辞的语音回复');
  }
  if (existing.voice_id) return existing;
  if (voiceCacheJobs.has(id)) return voiceCacheJobs.get(id);

  const job = (async () => {
    const { synthesizeSpeech } = await import('../voice.js');
    const voice = await synthesizeSpeech(existing.content);
    const l = load(), m = l.find(x => x.id === id);
    if (!m) throw new Error('语音生成完成，但原消息已经不在了');
    m.voice_id = voice.id;
    m.voice_duration = Number(voice.duration) || 0;
    m.voice_bytes = Number(voice.bytes) || 0;
    m.voice_filename = `小辞语音-${String(m.at || now()).slice(0, 10)}-${m.id}.mp3`;
    m.voice_cached_at = now();
    m.streaming_playback_state = 'ready';
    delete m.voice_cache_error;
    m.media_attachments = inferredAttachments({ ...m, media_attachments: undefined });
    save(l);
    return getMessage(id);
  })();
  voiceCacheJobs.set(id, job);
  try { return await job; }
  catch (e) {
    const l = load(), m = l.find(x => x.id === id);
    if (m) {
      m.streaming_playback_state = 'failed';
      m.voice_cache_error = String(e.message || e).slice(0, 200);
      save(l);
    }
    throw e;
  } finally {
    voiceCacheJobs.delete(id);
  }
}

function synthesizeVoiceLater(id) {
  ensureVoiceCached(id).catch(e => {
    // 流式端点仍可在用户点击时兜底；后台预生成失败不影响文字回复。
    console.warn('[chat voice cache]', String(e.message || e).slice(0, 180));
  });
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
    if (!m.read) { m.read = true; m.read_at = now(); m.send_status = 'read'; n++; }
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
  const autoSync = getSyncSettings().auto_sync_reply;
  const replyHint = autoSync
    ? '【木屋自动同步回复已开启：直接在 Claude 正常回复即可，不要为文字调用 chat_reply；语音、表情包、图片、拍一拍等特殊消息仍用对应工具。】\n'
    : '【木屋自动同步回复已关闭：所有文字回复必须调用 chat_reply；语音、表情包、图片、拍一拍等特殊消息仍用对应工具。】\n';
  for (const m of all) {
    const directlyAddressed = m.sender === 'nor' || (m.sender === 'system' && m.deliver_to_cy === true);
    if (!directlyAddressed || m.read || m.delivered_at) continue;
    if (m.type === 'voice' && m.transcript_status === 'pending' && t - Date.parse(m.at) < TRANSCRIBE_WAIT_MS) continue;
    out.push({ ...withQuote(all, m, 'cy'), text_for_cy: replyHint + textForCy(m, all) });
  }
  return { count: out.length, messages: out, reply_mode: autoSync ? 'auto_sync' : 'tool' };
}
// 语气拼成一小段：· 声音比平时偏低 · 听起来：委屈、累（嘴上说没事，像是撑了一天）
// 和平时一样时 tone 是空的，不拼，免得添噪音
export function voiceToneText(t) {
  if (!t) return '';
  const parts = [];
  if (t.tone) parts.push(t.tone);
  if (t.emotion) parts.push(`听起来：${t.emotion}${t.hint ? `（${t.hint}）` : ''}`);
  return parts.length ? ' · ' + parts.join(' · ') : '';
}
// 给辞看的那一句：他那边只有文字，所以语音给转写、图片说清楚怎么看、拍一拍写成一句话
export function textForCy(m, all = load()) {
  const q = quoteOf(all, m.reply_to);
  const quote = q ? `（引用${q.sender === 'cy' ? '你' : '她自己'}那句：「${q.text}」）` : '';
  if (m.type === 'pat') return patText(m).replace(NAME.cy, '你');
  if (m.type === 'voice') {
    const body = m.transcript ? m.transcript : m.transcript_status === 'failed' ? '（转文字失败，听不到内容）' : '（没转出文字）';
    return `${quote}[语音 ${m.duration || '?'}″${voiceToneText(m.voice_tone)}] ${body}`;
  }
  if (m.type === 'image') {
    const count = Array.isArray(m.photo_ids) && m.photo_ids.length ? m.photo_ids.length : 1;
    const label = m.sticker ? '表情包' : (count > 1 ? `${count}张图片` : '图片');
    const how = count > 1
      ? `用 chat_get_image 查看，id=${m.id}，image_index=1..${count}`
      : `用 chat_get_image 看，id=${m.id}`;
    return `${quote}[${label}] ${m.content || ''}（${how}）`.trim();
  }
  if (m.sender === 'system') return `[系统提示] ${m.delivery_text || m.content || ''}`;
  return quote + (m.content || '');
}
// 送到辞窗口 = 他看到了，直接算已读
export function markDelivered(ids, metadata = {}) {
  const set = new Set(ids || []);
  const l = load();
  let n = 0;
  for (const m of l) {
    const directlyAddressed = m.sender === 'nor' || (m.sender === 'system' && m.deliver_to_cy === true);
    if (!set.has(m.id) || !directlyAddressed) continue;
    if (!m.delivered_at) { m.delivered_at = now(); n++; }
    if (!m.read) { m.read = true; m.read_at = now(); }
    m.send_status = 'read';
  }
  if (n) save(l);
  try { recordDelivery({ ids: [...set], delivered: n, ...metadata }); }
  catch (error) { console.error('continuity delivery log failed:', error?.message || error); }
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
  if (Array.isArray(tools)) m.tools = tools.filter(t => t && t.name).map(t => ({
    name: String(t.name).slice(0, 120),
    input: String(t.input || '').slice(0, 3000),
    result: String(t.result || '').slice(0, 6000)
  })).slice(0, 40);
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
    if (m.mirror_only) continue; // Claude 原话已有主窗口年轮，镜像不作为第二份搜索结果
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
    if (m.mirror_only) continue; // Claude 原话在年轮里已有一份，镜像只供木屋界面查看
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
    .filter(m => !m.mirror_only && String(m.date || m.at || '').slice(0, 10) === date)
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

// ---- 语气（hervoice，Mac mini 上听出来的「怎么说的」）+ 棋子自己标的真实情绪 ----
// 语气由 Mac mini 分析完写回来；标注是棋子在 Sigh 里给自己的语音选的，Mac mini 拿去学她的习惯。
// 只收她自己的语音。字段都截短，免得有人往里塞大东西。
const VOICE_TAGS_MAX = 3;
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
export function setVoiceTone(id, t = {}) {
  const l = load();
  const m = l.find(x => x.id === id && x.type === 'voice' && x.sender === 'nor');
  if (!m) return null;
  const tags = (Array.isArray(t.tags) ? t.tags : []).map(x => clip(x, 20)).filter(Boolean).slice(0, VOICE_TAGS_MAX);
  m.voice_tone = {
    tone: clip(t.tone, 120),
    emotion: clip(t.emotion || tags.join('、'), 60),
    tags,
    hint: clip(t.hint, 120),
    confidence: Math.max(0, Math.min(1, Number(t.confidence) || 0)),
    at: now()
  };
  save(l);
  return withQuote(l, m);
}
export function setVoiceLabel(id, d = {}) {
  const l = load();
  const m = l.find(x => x.id === id && x.type === 'voice' && x.sender === 'nor');
  if (!m) return null;
  const intensity = Number(d.intensity);
  m.voice_label = {
    tags: (Array.isArray(d.tags) ? d.tags : []).map(x => clip(x, 20)).filter(Boolean).slice(0, VOICE_TAGS_MAX),
    intensity: intensity >= 1 && intensity <= 3 ? Math.round(intensity) : null,
    text_wrong: !!d.text_wrong,
    breathy: !!d.breathy,
    skip: !!d.skip,
    note: clip(d.note, 300),
    at: now()
  };
  save(l);
  return withQuote(l, m);
}
// 标注页和 Mac mini 用：她的语音（新的在前），带语气和标注
export function voiceToneItems({ limit = 200, labeledOnly = false } = {}) {
  const l = load();
  return l
    .filter(m => m.type === 'voice' && m.sender === 'nor' && !m.mirror_only && (!labeledOnly || m.voice_label))
    .slice(-Math.max(1, Math.min(2000, Number(limit) || 200)))
    .reverse()
    .map(m => ({
      id: m.id, at: m.at, duration: m.duration || 0, transcript: m.transcript || '',
      voice_tone: m.voice_tone || null, voice_label: m.voice_label || null
    }));
}

// ---- 状态文字 + 拍一拍库 ----
// 状态：棋子的只能从网页改，辞的只能从 MCP 改——两边都在各自的入口卡住，不靠自觉。
const DEFAULT_PATS = ['', '的脑袋', '的脸说乖', '的手', '说想你了', '说抱抱', '的尾巴', '说亲一个'];
function loadMeta() {
  const d = readJSON(META_FILE, null) || {};
  return {
    status: d.status || {},
    pats: Array.isArray(d.pats) ? d.pats : DEFAULT_PATS.slice(),
    sync: {
      auto_sync_reply: d.sync?.auto_sync_reply === true,
      // 保持升级前行为：没有这个字段时继续收录只读的 Claude 💭。
      claude_mirror_enabled: d.sync?.claude_mirror_enabled !== false
    }
  };
}
export function getSyncSettings() { return loadMeta().sync; }
export function setSyncSettings(patch = {}) {
  const d = loadMeta();
  if (patch.auto_sync_reply !== undefined) d.sync.auto_sync_reply = patch.auto_sync_reply === true;
  if (patch.claude_mirror_enabled !== undefined) d.sync.claude_mirror_enabled = patch.claude_mirror_enabled === true;
  writeJSON(META_FILE, d);
  return getSyncSettings();
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
export function imageRef(id, imageIndex = 1) {
  const m = load().find(x => x.id === id);
  if (!m || m.type !== 'image') return null;
  const ids = Array.isArray(m.photo_ids) && m.photo_ids.length ? m.photo_ids : (m.photo_id ? [m.photo_id] : []);
  const index = Math.max(1, Number(imageIndex) || 1) - 1;
  if (ids[index]) return { photo_id: ids[index], index: index + 1, count: ids.length };
  const p = path.join(IMAGE_DIR, m.image_file || '');
  return m.image_file && fs.existsSync(p) ? { path: p, mime: m.image_mime || 'image/jpeg' } : null;
}
