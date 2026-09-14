import fs from 'fs';
import path from 'path';
import { now } from './muwen/common.js';

const DATA_DIR = process.env.DATA_DIR || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// 日记分两本，分开存，互不影响：
//   diary            辞的日记——原来那本，文件还是 diary.json，老数据原样
//   wife_observation 妻子观察日记——辞观察棋子写的，单独一个文件
// 两本都是辞自己写，没有自动总结。显示名在标签总表（muwen/labels.js）里，前端从 /api/labels 读。
export const DIARY_CATEGORIES = {
  diary: { file: 'diary.json', idPrefix: 'd' },
  wife_observation: { file: 'wife_observation.json', idPrefix: 'w' }
};
function fileOf(category) {
  const c = DIARY_CATEGORIES[category];
  if (!c) throw new Error(`日记分类只能是 ${Object.keys(DIARY_CATEGORIES).join(' / ')}`);
  return path.join(DATA_DIR, c.file);
}
function newId(category) {
  return DIARY_CATEGORIES[category].idPrefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
const withCategory = (category) => x => ({ ...x, category: x.category || category });

// 公开——棋子能看到；私密——只有辞自己（通过 MCP 工具）能看到，网页/给棋子的
// 接口一律不吐私密条目。这不是加密，是"棋子这边的入口不给"，别当成安全边界。
export function addDiaryEntry(text, visibility = 'public', category = 'diary', date = '') {
  const f = fileOf(category);
  const list = readJSON(f, []);
  const entry = {
    id: newId(category),
    text,
    visibility: visibility === 'private' ? 'private' : 'public',
    category,
    ...(date ? { date } : {}),
    addedAt: now()
  };
  list.push(entry);
  writeJSON(f, list);
  return entry;
}

// 给辞自己用的：公开私密都能看
export function getDiaryAll(limit = 50, category = 'diary') {
  return readJSON(fileOf(category), []).slice(-limit).reverse().map(withCategory(category));
}

// 给棋子/网页用的：只吐公开的
export function getDiaryPublic(limit = 50, category = 'diary') {
  return readJSON(fileOf(category), []).filter(x => x.visibility === 'public').slice(-limit).reverse().map(withCategory(category));
}
