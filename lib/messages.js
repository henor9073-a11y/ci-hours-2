import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function newId() { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function now() { return new Date().toISOString(); }

// "棋子想说"：比"讨论"轻量很多——棋子留句话，辞看到了可以回，也可以就只是看到、
// 不回。不走 open/resolved 那套流程，不是每条都要处理掉的待办。
export function leaveMessage(text) {
  const list = readJSON(MESSAGES_FILE, []);
  const entry = { id: newId(), text, addedAt: now(), reply: null };
  list.push(entry);
  writeJSON(MESSAGES_FILE, list);
  return entry;
}

export function getMessages(limit = 30) {
  const list = readJSON(MESSAGES_FILE, []);
  return list.slice(-limit).reverse();
}

// 回复是可选的——辞想回就回，不回也没关系，不强制。
export function replyMessage(id, text) {
  const list = readJSON(MESSAGES_FILE, []);
  const m = list.find(x => x.id === id);
  if (!m) return null;
  m.reply = { text, at: now() };
  writeJSON(MESSAGES_FILE, list);
  return m;
}
