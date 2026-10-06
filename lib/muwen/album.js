import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';
import { DATA_DIR, file, readJSON, writeJSON, newId, now, todayStr, isDate, fallbackOpts, effortOpts } from './common.js';
import { score, excerpt } from './search.js';

// 图片资产 v2：原图永不压缩覆盖；聊天、相册和表情包只引用同一份资产。
// originals/ 放逐字节原图，previews/ 放适合聊天和列表快速加载的预览图。
// 旧版 DATA_DIR/album/<filename> 继续可读，不做破坏性迁移。
const FILE = file('album.json');
const DIR = path.join(DATA_DIR, 'album');
const ORIGINAL_DIR = path.join(DIR, 'originals');
const PREVIEW_DIR = path.join(DIR, 'previews');
for (const d of [DIR, ORIGINAL_DIR, PREVIEW_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

export const MAX_BYTES = 2 * 1024 * 1024;        // 兼容旧字段：预览图目标上限
export const MAX_INPUT_BYTES = 20 * 1024 * 1024; // 原图收件上限（原图会完整保留）
const PREVIEW_EDGE = 1600;
const PREVIEW_TARGET = 1200 * 1024;
const PHOTO_MODEL = process.env.MUWEN_PHOTO_MODEL || process.env.MUWEN_SEMANTIC_MODEL || 'claude-haiku-4-5';
const PHOTO_TIMEOUT_MS = Number(process.env.MUWEN_PHOTO_TIMEOUT_MS) || 30000;

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/heic': 'heic', 'image/heif': 'heif'
};
export const ACCEPTED_MIME = Object.keys(EXT);

function load() { return readJSON(FILE, []); }
function save(list) { writeJSON(FILE, list); }
function hasVisionKey() { return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN); }

function view(p) {
  const { filename, original_filename, preview_filename, ...rest } = p;
  return { ...rest, caption: p.caption || p.description || '' };
}

function rawMeta(id) { return load().find(x => x.id === id) || null; }
function existingPath(...parts) {
  for (const p of parts.filter(Boolean)) if (fs.existsSync(p)) return p;
  return null;
}
function legacyPath(p) { return p?.filename ? path.join(DIR, p.filename) : null; }

export function getPhotoPath(id) {
  const p = rawMeta(id);
  if (!p) return null;
  return existingPath(
    p.preview_filename && path.join(PREVIEW_DIR, p.preview_filename),
    legacyPath(p),
    p.original_filename && path.join(ORIGINAL_DIR, p.original_filename)
  );
}

export function getPhotoOriginalPath(id) {
  const p = rawMeta(id);
  if (!p) return null;
  return existingPath(
    p.original_filename && path.join(ORIGINAL_DIR, p.original_filename),
    legacyPath(p)
  );
}

async function makePreview(buf, mime) {
  const meta = await sharp(buf, { animated: true }).metadata();
  const animated = (meta.pages || 1) > 1;
  const alpha = !!meta.hasAlpha;
  const passthrough = !['image/heic', 'image/heif'].includes(mime)
    && buf.length <= 600 * 1024
    && (meta.width || 0) <= PREVIEW_EDGE
    && (meta.height || 0) <= PREVIEW_EDGE;
  if (passthrough) return { buf, mime, width: meta.width, height: meta.height, generated: false };

  const format = (animated || alpha) ? 'webp' : 'jpeg';
  const outMime = format === 'webp' ? 'image/webp' : 'image/jpeg';
  let width = PREVIEW_EDGE;
  let out = null;
  for (const quality of [82, 72, 62]) {
    const img = sharp(buf, animated ? { animated: true } : {}).rotate()
      .resize({ width, height: width, fit: 'inside', withoutEnlargement: true });
    out = await (format === 'webp'
      ? img.webp({ quality, effort: 4 }).toBuffer()
      : img.jpeg({ quality, mozjpeg: true }).toBuffer());
    if (out.length <= PREVIEW_TARGET) break;
    width = Math.max(960, Math.round(width * 0.78));
  }
  const outMeta = await sharp(out).metadata();
  return { buf: out, mime: outMime, width: outMeta.width, height: outMeta.height, generated: true };
}

function updatePhoto(id, patch) {
  const list = load();
  const p = list.find(x => x.id === id);
  if (!p) return null;
  Object.assign(p, patch, { updated_at: now() });
  save(list);
  return p;
}

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' }, ocr_text: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    scene: { type: 'string' }, mood: { type: 'string' }
  },
  required: ['description', 'ocr_text', 'tags', 'scene', 'mood'], additionalProperties: false
};

let analysisQueue = Promise.resolve();

export async function analyzePhoto(id, { force = false } = {}) {
  const p = rawMeta(id);
  if (!p) throw new Error('找不到这张照片');
  if (!force && p.analysis_status === 'done') return view(p);
  if (!hasVisionKey()) return view(updatePhoto(id, { analysis_status: 'unconfigured', analysis_error: '服务器没配置图片理解模型' }));
  const preview = getPhotoPath(id);
  if (!preview) return view(updatePhoto(id, { analysis_status: 'failed', analysis_error: '图片文件不存在' }));

  updatePhoto(id, { analysis_status: 'running', analysis_error: '' });
  try {
    const bytes = fs.readFileSync(preview);
    const current = rawMeta(id);
    const mime = current.preview_mime_type || current.mime_type || 'image/jpeg';
    const client = new Anthropic();
    const res = await client.beta.messages.create({
      model: PHOTO_MODEL, max_tokens: 1200, ...fallbackOpts(PHOTO_MODEL),
      system: '你在给私人相册建立可召回索引。客观描述画面，不猜真实姓名或敏感身份；完整抄录清晰可见的文字。description 用中文写一到三句，tags 只放具体的人物关系、物体、地点类型、活动和视觉主题。',
      output_config: { ...effortOpts(PHOTO_MODEL, 'low'), format: { type: 'json_schema', schema: ANALYSIS_SCHEMA } },
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: bytes.toString('base64') } },
        { type: 'text', text: `用户手写说明：${current.caption || '（没有）'}\n请生成图片描述、OCR、标签、场景和氛围。` }
      ] }]
    }, { timeout: PHOTO_TIMEOUT_MS });
    const parsed = JSON.parse(res.content.filter(x => x.type === 'text').map(x => x.text).join(''));
    return view(updatePhoto(id, {
      vision_description: String(parsed.description || '').trim(),
      ocr_text: String(parsed.ocr_text || '').trim(),
      auto_tags: Array.isArray(parsed.tags) ? [...new Set(parsed.tags.map(String).filter(Boolean))].slice(0, 20) : [],
      scene: String(parsed.scene || '').trim(), mood: String(parsed.mood || '').trim(),
      analysis_status: 'done', analysis_model: res.model, analyzed_at: now(), analysis_error: ''
    }));
  } catch (e) {
    return view(updatePhoto(id, { analysis_status: 'failed', analysis_error: String(e.message || e).slice(0, 300) }));
  }
}

function queueAnalysis(id) {
  if (!hasVisionKey()) return;
  analysisQueue = analysisQueue.then(() => analyzePhoto(id)).catch(() => {});
}

async function mirrorOriginal(id) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  const bucket = process.env.SUPABASE_IMAGE_BUCKET || '';
  if (!url || !key || !bucket) return;
  const p = rawMeta(id), source = getPhotoOriginalPath(id);
  if (!p || !source) return;
  updatePhoto(id, { cloud_status: 'uploading' });
  const objectPath = `originals/${p.original_filename || path.basename(source)}`;
  try {
    const target = objectPath.split('/').map(encodeURIComponent).join('/');
    const r = await fetch(`${url}/storage/v1/object/${encodeURIComponent(bucket)}/${target}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': p.original_mime_type || p.mime_type, 'x-upsert': 'true' },
      body: fs.readFileSync(source)
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 180)}`);
    updatePhoto(id, { cloud_status: 'uploaded', cloud_bucket: bucket, cloud_path: objectPath, cloud_synced_at: now(), cloud_error: '' });
  } catch (e) {
    updatePhoto(id, { cloud_status: 'failed', cloud_error: String(e.message || e).slice(0, 300) });
  }
}

function queueMirror(id) {
  const configured = process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY) && process.env.SUPABASE_IMAGE_BUCKET;
  if (configured) setImmediate(() => mirrorOriginal(id));
}

export async function savePhoto({ image_base64, mime_type, caption, description, date, tags = [], visibility = 'album' }) {
  if (!image_base64) throw new Error('image_base64 不能为空');
  if (!EXT[mime_type]) throw new Error(`mime_type 只支持 ${ACCEPTED_MIME.join('/')}`);
  if (date && !isDate(date)) throw new Error('date 要是 YYYY-MM-DD');
  const original = Buffer.from(String(image_base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!original.length) throw new Error('图片数据解不出来，确认是 base64');
  if (original.length > MAX_INPUT_BYTES) throw new Error(`图片 ${(original.length / 1048576).toFixed(1)}MB，超过 ${MAX_INPUT_BYTES / 1048576}MB 的收件上限`);

  let originalMeta;
  try { originalMeta = await sharp(original, { animated: true }).metadata(); }
  catch (e) { throw new Error(`图片解不开：${e.message || e}`); }
  let preview;
  try { preview = await makePreview(original, mime_type); }
  catch (e) { throw new Error(`预览图生成失败：${e.message || e}`); }

  const id = newId('ph');
  const originalFilename = `${id}.${EXT[mime_type]}`;
  const previewFilename = `${id}.${EXT[preview.mime] || 'jpg'}`;
  fs.writeFileSync(path.join(ORIGINAL_DIR, originalFilename), original);
  fs.writeFileSync(path.join(PREVIEW_DIR, previewFilename), preview.buf);

  const cloudConfigured = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY) && process.env.SUPABASE_IMAGE_BUCKET);
  const entry = {
    id, filename: previewFilename, original_filename: originalFilename, preview_filename: previewFilename,
    asset_version: 2, visibility: visibility === 'chat' ? 'chat' : 'album',
    mime_type: preview.mime, preview_mime_type: preview.mime, original_mime_type: mime_type,
    caption: String(caption || description || '').trim(), date: date || todayStr(),
    tags: Array.isArray(tags) ? [...new Set(tags.map(String).filter(Boolean))] : [],
    bytes: preview.buf.length, preview_bytes: preview.buf.length, original_bytes: original.length,
    compressed: preview.generated, width: preview.width, height: preview.height,
    original_width: originalMeta.width, original_height: originalMeta.height,
    analysis_status: hasVisionKey() ? 'pending' : 'unconfigured',
    cloud_status: cloudConfigured ? 'pending' : 'unconfigured', created_at: now()
  };
  const list = load(); list.push(entry); save(list);
  queueAnalysis(id); queueMirror(id);

  const warnings = [];
  if (!entry.caption) warnings.push('没有填写 caption；后台图片理解完成后仍可按画面和图片文字召回。');
  return {
    photo: view(entry), compressed: preview.generated, original_preserved: true,
    note: `原图已完整保留（${(original.length / 1048576).toFixed(2)}MB）；聊天预览${preview.generated ? '已自动压缩为' : '为'} ${(preview.buf.length / 1048576).toFixed(2)}MB，发送不用等图片分析完成。`,
    warnings
  };
}

export async function savePhotoFromPath(source, { mime_type = 'image/jpeg', ...meta } = {}) {
  return savePhoto({ ...meta, mime_type, image_base64: fs.readFileSync(source).toString('base64') });
}

export function promotePhoto(id, { caption, tags, date } = {}) {
  const p = rawMeta(id);
  if (!p) return null;
  const patch = { visibility: 'album' };
  if (caption !== undefined && String(caption).trim()) patch.caption = String(caption).trim();
  if (date) { if (!isDate(date)) throw new Error('date 要是 YYYY-MM-DD'); patch.date = date; }
  if (Array.isArray(tags)) patch.tags = [...new Set([...(p.tags || []), ...tags.map(String).filter(Boolean)])];
  const updated = updatePhoto(id, patch);
  if (updated && updated.analysis_status !== 'done') queueAnalysis(id);
  return updated ? view(updated) : null;
}

export function listPhotos({ from, to, tag, limit = 50, include_chat = false } = {}) {
  let list = load();
  if (!include_chat) list = list.filter(p => p.visibility !== 'chat');
  if (from) list = list.filter(p => p.date >= from);
  if (to) list = list.filter(p => p.date <= to);
  if (tag) list = list.filter(p => (p.tags || []).includes(tag));
  return list.sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at)).slice(0, limit).map(view);
}

function searchText(p) {
  return [p.caption || p.description, p.vision_description, p.ocr_text, p.scene, p.mood, ...(p.tags || []), ...(p.auto_tags || [])].filter(Boolean).join(' ');
}

export function searchPhotos(query, limit = 5) {
  const q = String(query || '').trim();
  if (!q) return [];
  return load().filter(p => p.visibility !== 'chat')
    .map(p => ({ p, s: score(q, searchText(p)) })).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s).slice(0, limit)
    .map(x => ({ ...view(x.p), score: x.s, excerpt: excerpt(searchText(x.p), q, 90) }));
}

const RECALL_SCHEMA = { type: 'object', properties: { picks: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'], additionalProperties: false } } }, required: ['picks'], additionalProperties: false };

export async function recallPhotos(query, { limit = 3 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query 不能为空');
  const keyword = searchPhotos(q, limit);
  if (!hasVisionKey()) return { query: q, mode: 'keyword', photos: keyword };
  const photos = load().filter(p => p.visibility !== 'chat' && searchText(p)).slice(-800);
  if (!photos.length) return { query: q, mode: 'empty', photos: [] };
  const ids = new Set(photos.map(p => p.id));
  const index = photos.map(p => `${p.id} ${p.date || ''} ${searchText(p).replace(/\s+/g, ' ').slice(0, 260)}`).join('\n');
  try {
    const client = new Anthropic();
    const res = await client.beta.messages.create({
      model: PHOTO_MODEL, max_tokens: 900, ...fallbackOpts(PHOTO_MODEL),
      system: `你在私人相册索引里按意思找图片。只挑真正能回答用户此刻联想的图，没有就返回空。最多 ${Math.min(limit, 5)} 张。只能使用索引里的 id。\n\n图片索引：\n${index}`,
      output_config: { ...effortOpts(PHOTO_MODEL, 'low'), format: { type: 'json_schema', schema: RECALL_SCHEMA } },
      messages: [{ role: 'user', content: q }]
    }, { timeout: PHOTO_TIMEOUT_MS });
    const parsed = JSON.parse(res.content.filter(x => x.type === 'text').map(x => x.text).join(''));
    const byId = new Map(photos.map(p => [p.id, p]));
    const picked = (parsed.picks || []).filter(x => ids.has(x.id)).slice(0, Math.min(limit, 5))
      .map(x => ({ ...view(byId.get(x.id)), reason: String(x.reason || '') }));
    return { query: q, mode: 'semantic', model: res.model, photos: picked };
  } catch (e) {
    return { query: q, mode: 'keyword-fallback', warning: String(e.message || e).slice(0, 200), photos: keyword };
  }
}

export function getPhotoMeta(id) { const p = rawMeta(id); return p ? view(p) : null; }

export function getPhoto(id, { original = true } = {}) {
  const p = rawMeta(id);
  if (!p) return null;
  const f = original ? getPhotoOriginalPath(id) : getPhotoPath(id);
  if (!f) return { ...view(p), image_base64: null, missing: true };
  const mime = original ? (p.original_mime_type || p.mime_type) : (p.preview_mime_type || p.mime_type);
  return { ...view(p), returned: original ? 'original' : 'preview', returned_mime_type: mime, image_base64: fs.readFileSync(f).toString('base64') };
}

export function deletePhoto(id) {
  const list = load(); const idx = list.findIndex(p => p.id === id);
  if (idx === -1) return null;
  const [p] = list.splice(idx, 1); save(list);
  const paths = [legacyPath(p), p.original_filename && path.join(ORIGINAL_DIR, p.original_filename), p.preview_filename && path.join(PREVIEW_DIR, p.preview_filename)];
  for (const f of new Set(paths.filter(Boolean))) if (fs.existsSync(f)) fs.unlinkSync(f);
  return view(p);
}
