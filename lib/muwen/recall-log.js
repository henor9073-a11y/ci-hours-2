import fs from 'fs';
import path from 'path';
import { file, readJSON, todayStr } from './common.js';
import { isReadonly } from './readonly.js';

// 召回日志的存储层（2026-11-14 改）。
//
// 以前所有召回日志都在一个 recall_logs.json 里，每次召回要把它整个读两遍（算 30 分钟压制、
// 追加前再读一遍）再整表重写一遍。9 月起只增不删，11 月已经 2 万多条、62MB，
// 同步 I/O 一次就是好几秒，还把 Node 主线程堵住，别的请求跟着排队——
// 棋子每句话之后固定等十几秒，大头就在这儿（审查报告 CI-HOURS-recall审查-2026-11-14 问题 1）。
//
// 现在：
//   · 新日志按天追加写进 recall_logs/YYYY-MM-DD.jsonl（一行一条），永远不整表重写；
//   · 进程里保留最近 RECENT_KEEP 条，30 分钟压制只看内存，不碰文件；
//   · 旧的大文件 recall_logs.json **不迁移、不改写**：启动后第一次用到时读一次尾部
//     （只取最后 LEGACY_TAIL 条，正文截短），之后再也不碰它。线上那份就留在盘上，
//     归档/拆分以后单独做；
//   · notice / context_summary 存前截到 TEXT_LIMIT 字——日志是用来回看"召回准不准"的，
//     不是用来保存棋子粘贴的两万字正文的（旧文件里最长一条 20 万字就是这么来的）。
//
// 对外接口和以前一样：appendRecallLog(entry)、recentRecallLogs()（旧→新）、getRecallLogs(limit)（新→旧）。

export const LEGACY_FILE = file('recall_logs.json');
export const LOG_DIR = file('recall_logs');
export const RECENT_KEEP = Number(process.env.MUWEN_RECALL_LOG_RECENT) || 200;
// 旧文件只读一次尾部，取这么多条。够 /api/recall-logs 翻最近几页，也够压制名单接上。
export const LEGACY_TAIL = Number(process.env.MUWEN_RECALL_LOG_LEGACY_TAIL) || 1000;
export const TEXT_LIMIT = Number(process.env.MUWEN_RECALL_LOG_TEXT_LIMIT) || 300;

let recent = null;        // 最近 RECENT_KEEP 条，旧 → 新
let legacyTail = null;    // 旧大文件的尾部快照（只读一次）
let legacyInfo = null;    // { exists, size, loaded_ms, entries } 给状态接口看

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

function clip(s) {
  if (s === undefined || s === null) return s;
  const t = String(s);
  return t.length > TEXT_LIMIT ? t.slice(0, TEXT_LIMIT) + '…' : t;
}

// 存之前把会很长的两个字段截短。其余字段（returned_ids、layers、via…）本来就短。
export function trimEntry(entry) {
  const e = { ...entry };
  if (e.notice !== undefined) e.notice = clip(e.notice);
  if (e.context_summary !== undefined) e.context_summary = clip(e.context_summary);
  return e;
}

function dateOf(entry) {
  const d = String(entry?.created_at || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : todayStr();
}

// 按天文件名，新的在前
function dayFiles() {
  let names = [];
  try { names = fs.readdirSync(LOG_DIR); } catch { return []; }
  return names.filter(n => DAY_FILE.test(n)).sort().reverse();
}

// 读一天的 jsonl（旧 → 新）。写到一半被杀留下的坏行直接跳过。
function readDay(name) {
  let text = '';
  try { text = fs.readFileSync(path.join(LOG_DIR, name), 'utf-8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 半行，跳过 */ }
  }
  return out;
}

// 旧大文件：进程生命周期内只读这一次。读完只留尾部、正文截短，内存里不超过一两 MB。
export function loadLegacyTail() {
  if (legacyTail) return legacyTail;
  const t0 = Date.now();
  let st = null;
  try { st = fs.statSync(LEGACY_FILE); } catch { st = null; }
  if (!st) {
    legacyTail = [];
    legacyInfo = { exists: false, size: 0, loaded_ms: 0, entries: 0 };
    return legacyTail;
  }
  const all = readJSON(LEGACY_FILE, []);
  legacyTail = (Array.isArray(all) ? all : []).slice(-LEGACY_TAIL).map(trimEntry);
  legacyInfo = { exists: true, size: st.size, loaded_ms: Date.now() - t0, entries: legacyTail.length };
  return legacyTail;
}

// 内存里的最近 N 条。第一次用到时从 jsonl（新到旧）凑，不够再拿旧文件的尾部补。
function ensureRecent() {
  if (recent) return recent;
  let list = [];
  for (const name of dayFiles()) {
    list = readDay(name).concat(list);
    if (list.length >= RECENT_KEEP) break;
  }
  if (list.length < RECENT_KEEP) list = [...loadLegacyTail(), ...list];
  recent = list.slice(-RECENT_KEEP);
  return recent;
}

// 启动后预热一次（server.js 在 listen 之后 setImmediate 调），
// 让"读一次旧文件尾部"这几秒落在启动期，而不是棋子第一句话上。
export function warmRecallLogs() {
  try { ensureRecent(); } catch (e) { console.error('[muwen] 召回日志预热失败：', e.message || e); }
  return recallLogStats();
}

export function appendRecallLog(entry) {
  // 木纹网页只读：不记日志（跟以前一样）
  if (isReadonly()) return entry;
  const e = trimEntry(entry);
  const list = ensureRecent();
  list.push(e);
  if (list.length > RECENT_KEEP) list.splice(0, list.length - RECENT_KEEP);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `${dateOf(e)}.jsonl`), JSON.stringify(e) + '\n');
  } catch (err) {
    // 日志写失败不影响召回本身
    console.error('[muwen] 召回日志写入失败：', err.message || err);
  }
  return e;
}

// 给 30 分钟压制用：最近 RECENT_KEEP 条，旧 → 新。只读内存。
export function recentRecallLogs() { return ensureRecent(); }

// 给 /api/recall-logs 和 get_recall_logs 用：新 → 旧，最多 limit 条。
// 先翻按天文件（今天、昨天…），不够再接旧文件的尾部快照。
// 旧文件尾部之外的更早历史不在这里给——它们还躺在 recall_logs.json 里，要看就单独拆。
export function getRecallLogs(limit = 30) {
  const want = Math.max(1, Number(limit) || 30);
  const out = [];
  for (const name of dayFiles()) {
    const day = readDay(name);
    for (let i = day.length - 1; i >= 0 && out.length < want; i--) out.push(day[i]);
    if (out.length >= want) break;
  }
  if (out.length < want) {
    const tail = loadLegacyTail();
    for (let i = tail.length - 1; i >= 0 && out.length < want; i--) out.push(tail[i]);
  }
  return out;
}

export function recallLogStats() {
  const files = dayFiles();
  return {
    dir: LOG_DIR, day_files: files.length, latest_day: files[0] ? files[0].slice(0, 10) : null,
    recent_in_memory: recent ? recent.length : 0, recent_keep: RECENT_KEEP,
    legacy: legacyInfo || { exists: fs.existsSync(LEGACY_FILE), loaded: false }
  };
}

// 只给测试用：清掉进程内缓存，模拟重启
export function _resetForTests() { recent = null; legacyTail = null; legacyInfo = null; }
