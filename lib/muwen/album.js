import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { DATA_DIR, file, readJSON, writeJSON, newId, now, todayStr, isDate } from './common.js';
import { score, excerpt } from './search.js';

// 相册。图片二进制存 DATA_DIR/album/<id>.<ext>，元数据存 album.json，列表接口不带图片数据。
// 大图后端自动压缩——调用方不用自己先压。caption 是每张照片的一句标注，用来以后召回（search_all 能搜到）。

const FILE = file('album.json');
const DIR = path.join(DATA_DIR, 'album');
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

export const MAX_BYTES = 2 * 1024 * 1024;        // 存下来的目标大小：超过就压
export const MAX_INPUT_BYTES = 20 * 1024 * 1024; // 收进来的硬上限：再大就别传了
const MAX_EDGE = 2048;                            // 压缩时最长边不超过这个

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/heic': 'heic', 'image/heif': 'heif'
};
export const ACCEPTED_MIME = Object.keys(EXT);

function load() { return readJSON(FILE, []); }
function save(list) { writeJSON(FILE, list); }

// 老条目只有 description，新条目用 caption——读的时候统一成 caption，不改老数据。
function view(p) {
  const { filename, ...rest } = p;
  return { ...rest, caption: p.caption || p.description || '' };
}

// 自动压缩：只在超过 2MB（或者是浏览器打不开的 HEIC）时动手。
// 有透明通道或者是动图 → webp（能保住 alpha 和帧）；其余 → jpeg。
// 先降画质再降分辨率，够小了就停，压不到也存最后一次的结果，不让它失败。
async function compress(buf, mime) {
  const meta = await sharp(buf).metadata();
  const animated = (meta.pages || 1) > 1;
  const alpha = !!meta.hasAlpha;
  const format = (animated || alpha) ? 'webp' : 'jpeg';
  const outMime = format === 'webp' ? 'image/webp' : 'image/jpeg';

  let width = Math.min(meta.width || MAX_EDGE, MAX_EDGE);
  const qualities = [82, 74, 66, 58, 50, 42];
  let out = null;
  for (let i = 0; i < qualities.length; i++) {
    let img = sharp(buf, animated ? { animated: true } : {});
    if (meta.width && meta.width > width) img = img.resize({ width, withoutEnlargement: true });
    out = await (format === 'webp' ? img.webp({ quality: qualities[i] }) : img.jpeg({ quality: qualities[i], mozjpeg: true })).toBuffer();
    if (out.length <= MAX_BYTES) break;
    if (i >= 1) width = Math.max(640, Math.round(width * 0.75)); // 画质降过两档还不行就缩尺寸
  }
  const outMeta = await sharp(out).metadata();
  return { buf: out, mime: outMime, width: outMeta.width, height: outMeta.height, format };
}

export async function savePhoto({ image_base64, mime_type, caption, description, date, tags = [] }) {
  if (!image_base64) throw new Error('image_base64 不能为空');
  if (!EXT[mime_type]) throw new Error(`mime_type 只支持 ${ACCEPTED_MIME.join('/')}`);
  if (date && !isDate(date)) throw new Error('date 要是 YYYY-MM-DD');

  const data = String(image_base64).replace(/^data:[^;]+;base64,/, '');
  let buf = Buffer.from(data, 'base64');
  if (!buf.length) throw new Error('图片数据解不出来，确认是 base64');
  if (buf.length > MAX_INPUT_BYTES) {
    throw new Error(`图片 ${(buf.length / 1048576).toFixed(1)}MB，超过 ${MAX_INPUT_BYTES / 1048576}MB 的收件上限，先在手机上裁一下再传`);
  }

  const originalBytes = buf.length;
  const isHeic = mime_type === 'image/heic' || mime_type === 'image/heif';
  let outMime = mime_type;
  let dims = null;
  let compressed = false;

  // HEIC 浏览器打不开，不管多大都转一份；其余只有超过 2MB 才压。
  if (buf.length > MAX_BYTES || isHeic) {
    try {
      const r = await compress(buf, mime_type);
      buf = r.buf; outMime = r.mime; dims = { width: r.width, height: r.height };
      compressed = true;
    } catch (e) {
      if (isHeic) throw new Error(`这张 HEIC 解不开（服务器的 sharp 可能没带 heif 解码）：${e.message || e}`);
      throw new Error(`压缩失败：${e.message || e}`);
    }
  } else {
    try { const m = await sharp(buf).metadata(); dims = { width: m.width, height: m.height }; } catch { /* 拿不到尺寸不影响存 */ }
  }

  const id = newId('ph');
  const filename = `${id}.${EXT[outMime] || 'jpg'}`;
  fs.writeFileSync(path.join(DIR, filename), buf);

  const list = load();
  const entry = {
    id, filename, mime_type: outMime,
    caption: String(caption || description || '').trim(),
    date: date || todayStr(),
    tags: Array.isArray(tags) ? tags.map(String).filter(Boolean) : [],
    bytes: buf.length,
    ...(compressed ? { original_bytes: originalBytes, compressed: true } : {}),
    ...(dims && dims.width ? { width: dims.width, height: dims.height } : {}),
    created_at: now()
  };
  list.push(entry);
  save(list);

  const warnings = [];
  if (!entry.caption) warnings.push('这张没写 caption——以后想召回它就只能靠日期翻。补一句：谁、在干嘛、当时什么感觉。');
  return {
    photo: view(entry),
    compressed,
    ...(compressed ? { note: `原图 ${(originalBytes / 1048576).toFixed(2)}MB → 存下 ${(buf.length / 1048576).toFixed(2)}MB（${outMime}${dims && dims.width ? `，${dims.width}×${dims.height}` : ''}），后端自动压的，不用自己先处理。` } : {}),
    warnings
  };
}

export function listPhotos({ from, to, tag, limit = 50 } = {}) {
  let list = load();
  if (from) list = list.filter(p => p.date >= from);
  if (to) list = list.filter(p => p.date <= to);
  if (tag) list = list.filter(p => (p.tags || []).includes(tag));
  return list.sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at)).slice(0, limit).map(view);
}

// 按 caption / 标签搜照片——caption 就是为了这个存的。search_all 会带上这一层。
export function searchPhotos(query, limit = 5) {
  const q = String(query || '').trim();
  if (!q) return [];
  return load()
    .map(p => ({ p, s: score(q, `${p.caption || p.description || ''} ${(p.tags || []).join(' ')}`) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => ({ ...view(x.p), score: x.s, excerpt: excerpt(x.p.caption || x.p.description || '', q, 60) }));
}

export function getPhotoMeta(id) { const p = load().find(x => x.id === id); return p ? view(p) : null; }
function rawMeta(id) { return load().find(x => x.id === id) || null; }

export function getPhotoPath(id) {
  const p = rawMeta(id);
  if (!p) return null;
  const f = path.join(DIR, p.filename);
  return fs.existsSync(f) ? f : null;
}

export function getPhoto(id) {
  const p = rawMeta(id);
  if (!p) return null;
  const f = path.join(DIR, p.filename);
  if (!fs.existsSync(f)) return { ...view(p), image_base64: null, missing: true };
  return { ...view(p), image_base64: fs.readFileSync(f).toString('base64') };
}

export function deletePhoto(id) {
  const list = load();
  const idx = list.findIndex(p => p.id === id);
  if (idx === -1) return null;
  const [p] = list.splice(idx, 1);
  save(list);
  const f = path.join(DIR, p.filename);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  return view(p);
}
