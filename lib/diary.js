import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';
const DIARY_FILE = path.join(DATA_DIR, 'diary.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function newId() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function now() { return new Date().toISOString(); }

// 日记：辞醒来的时候自己决定写不写、写公开的还是私密的。
// 公开——棋子能看到；私密——只有辞自己（通过 MCP 工具）能看到，网页/给棋子的
// 接口一律不吐私密条目。这不是加密，是"棋子这边的入口不给"，别当成安全边界。
export function addDiaryEntry(text, visibility = 'public') {
  const list = readJSON(DIARY_FILE, []);
  const entry = {
    id: newId(),
    text,
    visibility: visibility === 'private' ? 'private' : 'public',
    addedAt: now()
  };
  list.push(entry);
  writeJSON(DIARY_FILE, list);
  return entry;
}

// 给辞自己用的：公开私密都能看，这是她自己的完整日记
export function getDiaryAll(limit = 50) {
  const list = readJSON(DIARY_FILE, []);
  return list.slice(-limit).reverse();
}

// 给棋子/网页用的：只吐公开的
export function getDiaryPublic(limit = 50) {
  const list = readJSON(DIARY_FILE, []);
  return list.filter(x => x.visibility === 'public').slice(-limit).reverse();
}
