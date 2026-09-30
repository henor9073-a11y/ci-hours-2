import fs from 'fs';
import path from 'path';
import { now } from './muwen/common.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const WHEELS_FILE = path.join(DATA_DIR, 'wheels.json');
const NOTES_FILE = path.join(DATA_DIR, 'board-notes.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function read(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function id(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function actor(v) { return v === '辞' ? '辞' : '棋子'; }
function strokes(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 80).map(s => ({
    color: /^#[0-9a-f]{6}$/i.test(String(s?.color || '')) ? s.color : '#a8657c',
    width: Math.min(18, Math.max(1, Number(s?.width) || 3)),
    points: (Array.isArray(s?.points) ? s.points : []).slice(0, 500).map(p => [Math.min(100, Math.max(0, Number(p?.[0]) || 0)), Math.min(100, Math.max(0, Number(p?.[1]) || 0))])
  })).filter(s => s.points.length > 1);
}

export function getWheels() { return read(WHEELS_FILE, { wheels: [], history: [] }); }
export function createWheel({ name, options, by }) {
  const db = getWheels();
  if (db.wheels.length >= 10) throw new Error('最多只能有 10 个转盘');
  const opts = [...new Set((options || []).map(x => String(x).trim()).filter(Boolean))];
  if (opts.length < 2 || opts.length > 20) throw new Error('每个转盘需要 2～20 个选项');
  const wheel = { id: id('w'), name: String(name || '未命名转盘').trim().slice(0, 40), options: opts, created_by: actor(by), created_at: now(), updated_at: now() };
  db.wheels.push(wheel); write(WHEELS_FILE, db); return wheel;
}
export function updateWheel(wheelId, patch = {}) {
  const db = getWheels(), wheel = db.wheels.find(x => x.id === wheelId);
  if (!wheel) throw new Error('找不到这个转盘');
  if (patch.name != null) wheel.name = String(patch.name).trim().slice(0, 40) || wheel.name;
  if (patch.options) {
    const opts = [...new Set(patch.options.map(x => String(x).trim()).filter(Boolean))];
    if (opts.length < 2 || opts.length > 20) throw new Error('每个转盘需要 2～20 个选项');
    wheel.options = opts;
  }
  wheel.updated_at = now(); write(WHEELS_FILE, db); return wheel;
}
export function removeWheel(wheelId) { const db = getWheels(); db.wheels = db.wheels.filter(x => x.id !== wheelId); write(WHEELS_FILE, db); return { ok: true }; }
export function spinWheel(wheelId, by) {
  const db = getWheels(), wheel = db.wheels.find(x => x.id === wheelId);
  if (!wheel) throw new Error('找不到这个转盘');
  const index = Math.floor(Math.random() * wheel.options.length);
  const item = { id: id('spin'), wheel_id: wheel.id, wheel_name: wheel.name, options: [...wheel.options], result: wheel.options[index], result_index: index, by: actor(by), at: now() };
  db.history.unshift(item); db.history = db.history.slice(0, 1000); write(WHEELS_FILE, db); return item;
}

export function getBoardNotes() { return read(NOTES_FILE, []); }
export function createBoardNote(input = {}) {
  const notes = getBoardNotes();
  const note = { id: id('bn'), text: String(input.text || '').slice(0, 3000), drawing: String(input.drawing || ''), strokes: strokes(input.strokes), by: actor(input.by), x: Number(input.x ?? 12), y: Number(input.y ?? 12), color: String(input.color || '#fff1bd'), text_color: String(input.text_color || '#4b3d45'), font_size: Math.min(30, Math.max(11, Number(input.font_size) || 16)), bold: !!input.bold, underline: !!input.underline, archived: false, created_at: now(), updated_at: now() };
  if (!note.text.trim() && !note.drawing && !note.strokes.length) throw new Error('便签不能是空的');
  notes.push(note); write(NOTES_FILE, notes); return note;
}
export function updateBoardNote(noteId, patch = {}) {
  const notes = getBoardNotes(), note = notes.find(x => x.id === noteId);
  if (!note) throw new Error('找不到这张便签');
  for (const key of ['text', 'drawing', 'color', 'text_color']) if (patch[key] != null) note[key] = String(patch[key]);
  for (const key of ['x', 'y', 'font_size']) if (patch[key] != null && Number.isFinite(Number(patch[key]))) note[key] = Number(patch[key]);
  for (const key of ['bold', 'underline', 'archived']) if (patch[key] != null) note[key] = !!patch[key];
  if (patch.strokes != null) note.strokes = strokes(patch.strokes);
  note.updated_at = now(); write(NOTES_FILE, notes); return note;
}
export function archiveBoardNote(noteId) { return updateBoardNote(noteId, { archived: true }); }
export function restoreBoardNote(noteId) { return updateBoardNote(noteId, { archived: false }); }
