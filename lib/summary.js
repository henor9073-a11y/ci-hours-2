import fs from 'fs';
import path from 'path';

// 首页摘要——每次苏醒、每个新窗口最先读的那份东西。跟五类记忆(identity/feelings/
// facts/experiences/openThreads)不是一回事：那五类是散落的条目，这个是六段
// 已经写好、排好顺序的成品文字，读起来快，不用自己现拼。
// 六段固定顺序：identity(我是谁) → boundaries(我的边界和底线) → key_events(重要事件)
// → yesterday(昨天发生了什么) → relationships(我的重要关系) → thoughts(我的思考)。
// 每段都能整段改写，改之前的旧版本存进 history，不是覆盖就没了。

const DATA_DIR = process.env.DATA_DIR || './data';
const SUMMARY_FILE = path.join(DATA_DIR, 'summary.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function now() { return new Date().toISOString(); }

export const SECTIONS = ['identity', 'boundaries', 'key_events', 'yesterday', 'relationships', 'thoughts'];
export const SECTION_LABELS = {
  identity: '我是谁',
  boundaries: '我的边界和底线',
  key_events: '重要事件',
  yesterday: '昨天发生了什么',
  relationships: '我的重要关系',
  thoughts: '我的思考',
};

function emptySection() {
  return { text: '', updatedAt: null, history: [] };
}
function emptyFile() {
  const obj = {};
  for (const s of SECTIONS) obj[s] = emptySection();
  return obj;
}

function ensureFile() {
  if (fs.existsSync(SUMMARY_FILE)) return;
  writeJSON(SUMMARY_FILE, emptyFile());
}
ensureFile();

function load() {
  const data = readJSON(SUMMARY_FILE, emptyFile());
  // 防止后面加了新 section 但老文件里没有这个 key
  for (const s of SECTIONS) if (!data[s]) data[s] = emptySection();
  return data;
}

export function getSummary() {
  const data = load();
  return SECTIONS.map(s => ({
    section: s,
    label: SECTION_LABELS[s],
    text: data[s].text,
    updatedAt: data[s].updatedAt,
  }));
}

export function updateSummarySection(section, text) {
  if (!SECTIONS.includes(section)) throw new Error(`section 必须是 ${SECTIONS.join('/')} 之一`);
  const data = load();
  const cur = data[section];
  if (cur.text) {
    cur.history.push({ text: cur.text, archivedAt: now() });
  }
  cur.text = text;
  cur.updatedAt = now();
  writeJSON(SUMMARY_FILE, data);
  return { section, label: SECTION_LABELS[section], text: cur.text, updatedAt: cur.updatedAt };
}

export function getSummaryHistory(section) {
  if (!SECTIONS.includes(section)) throw new Error(`section 必须是 ${SECTIONS.join('/')} 之一`);
  const data = load();
  return data[section].history;
}
