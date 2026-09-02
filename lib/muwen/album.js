import fs from 'fs';
import path from 'path';
import { DATA_DIR, file, readJSON, writeJSON, newId, now, todayStr, isDate } from './common.js';

// 相册。图片二进制存 DATA_DIR/album/<id>.<ext>，元数据存 album.json，列表接口不带图片数据。
const FILE = file('album.json');
const DIR = path.join(DATA_DIR, 'album');
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

export const MAX_BYTES = 2 * 1024 * 1024; // 单张 2MB
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function load() { return readJSON(FILE, []); }
function save(list) { writeJSON(FILE, list); }

export function savePhoto({ image_base64, mime_type, description = '', date, tags = [] }) {
  if (!image_base64) throw new Error('image_base64 不能为空');
  if (!EXT[mime_type]) throw new Error(`mime_type 只支持 ${Object.keys(EXT).join('/')}`);
  if (date && !isDate(date)) throw new Error('date 要是 YYYY-MM-DD');
  const data = image_base64.replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw new Error('图片数据解不出来，确认是 base64');
  if (buf.length > MAX_BYTES) throw new Error(`图片 ${(buf.length / 1024 / 1024).toFixed(2)}MB，超过 2MB 上限，先压缩一下`);
  const id = newId('ph');
  const filename = `${id}.${EXT[mime_type]}`;
  fs.writeFileSync(path.join(DIR, filename), buf);
  const list = load();
  const entry = {
    id, filename, mime_type, description: String(description || ''), date: date || todayStr(),
    tags: Array.isArray(tags) ? tags.map(String) : [], bytes: buf.length, created_at: now()
  };
  list.push(entry);
  save(list);
  return entry;
}

export function listPhotos({ from, to, tag, limit = 50 } = {}) {
  let list = load();
  if (from) list = list.filter(p => p.date >= from);
  if (to) list = list.filter(p => p.date <= to);
  if (tag) list = list.filter(p => p.tags.includes(tag));
  return list.sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at)).slice(0, limit);
}

export function getPhotoMeta(id) { return load().find(p => p.id === id) || null; }
export function getPhotoPath(id) {
  const p = getPhotoMeta(id);
  if (!p) return null;
  const f = path.join(DIR, p.filename);
  return fs.existsSync(f) ? f : null;
}
export function getPhoto(id) {
  const p = getPhotoMeta(id);
  if (!p) return null;
  const f = path.join(DIR, p.filename);
  if (!fs.existsSync(f)) return { ...p, image_base64: null, missing: true };
  return { ...p, image_base64: fs.readFileSync(f).toString('base64') };
}

export function deletePhoto(id) {
  const list = load();
  const idx = list.findIndex(p => p.id === id);
  if (idx === -1) return null;
  const [p] = list.splice(idx, 1);
  save(list);
  const f = path.join(DIR, p.filename);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  return p;
}
