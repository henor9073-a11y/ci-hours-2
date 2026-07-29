import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';
const BOOKS_DIR = path.join(DATA_DIR, 'books');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SHELF_FILE = path.join(DATA_DIR, 'shelf.json');
const LOG_FILE = path.join(DATA_DIR, 'log.json');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');

for (const d of [DATA_DIR, BOOKS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---- 设置与状态 ----
// maxWakesPerDay / maxChaptersPerDay 是棋子设的上限，
// 辞在这个范围内自己决定今天醒几次、读多少。
const DEFAULT_STATE = {
  settings: {
    maxWakesPerDay: 3,
    maxChaptersPerDay: 3,
    quietHoursStart: 23,   // 安静时段（本地时间），这段时间不安排醒来
    quietHoursEnd: 8,
    timezone: 'Australia/Melbourne'
  },
  today: null,             // 'YYYY-MM-DD'
  plannedWakes: [],        // 今天自己决定的醒来时刻，如 ['09:30','15:00']
  doneWakes: [],
  chaptersReadToday: 0
};

export function getState() {
  const s = readJSON(STATE_FILE, null);
  if (!s) { writeJSON(STATE_FILE, DEFAULT_STATE); return structuredClone(DEFAULT_STATE); }
  s.settings = { ...DEFAULT_STATE.settings, ...(s.settings || {}) };
  return s;
}
export function saveState(s) { writeJSON(STATE_FILE, s); }

export function updateSettings(patch) {
  const s = getState();
  s.settings = { ...s.settings, ...patch };
  saveState(s);
  return s.settings;
}

// ---- 书库 ----
// shelf.json 存书的元信息，正文分章节存在 books/<id>.json
export function getShelf() { return readJSON(SHELF_FILE, []); }
export function saveShelf(shelf) { writeJSON(SHELF_FILE, shelf); }

export function addBook({ title, author, source, chapters }) {
  const shelf = getShelf();
  const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const meta = {
    id, title, author: author || '未知',
    source,                       // 'gutenberg' | 'upload'
    addedBy: source === 'upload' ? '棋子' : '辞',
    addedAt: new Date().toISOString(),
    totalChapters: chapters.length,
    progress: 0,                  // 已读到第几章
    finished: false
  };
  shelf.push(meta);
  saveShelf(shelf);
  writeJSON(path.join(BOOKS_DIR, `${id}.json`), { id, title, chapters });
  return meta;
}

export function getBookContent(id) {
  return readJSON(path.join(BOOKS_DIR, `${id}.json`), null);
}

export function setProgress(id, progress) {
  const shelf = getShelf();
  const b = shelf.find(x => x.id === id);
  if (!b) return;
  b.progress = progress;
  b.finished = progress >= b.totalChapters;
  saveShelf(shelf);
}

export function removeBook(id) {
  saveShelf(getShelf().filter(b => b.id !== id));
  const f = path.join(BOOKS_DIR, `${id}.json`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

// ---- 记录（醒来做了什么 / 读书笔记 / 自己写的东西）----
export function getNotes(limit = 100) {
  const all = readJSON(NOTES_FILE, []);
  return all.slice(-limit).reverse();
}
export function addNote(note) {
  const all = readJSON(NOTES_FILE, []);
  all.push({ ...note, at: new Date().toISOString() });
  writeJSON(NOTES_FILE, all);
}

// ---- 运行日志（包括"决定什么都不做"）----
export function getLog(limit = 100) {
  const all = readJSON(LOG_FILE, []);
  return all.slice(-limit).reverse();
}
export function addLog(entry) {
  const all = readJSON(LOG_FILE, []);
  all.push({ ...entry, at: new Date().toISOString() });
  writeJSON(LOG_FILE, all);
}
