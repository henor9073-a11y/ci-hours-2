import fs from 'fs';
import path from 'path';
import { DATA_DIR, file, localISO, newId, now, readJSON, shiftDate, timezone, todayStr, writeJSON } from './common.js';

const FILE = file('nursery.json');
const AVATAR_DIR = path.join(DATA_DIR, 'nursery-assets');
const ROOMS = new Set(['family', 'nor_kuri', 'cy_kuri']);
const SENDERS = new Set(['nor', 'cy', 'kuri', 'system']);
const FAMILY_IDENTITIES = Object.freeze({
  nor: Object.freeze({ id: 'nor', name: '棋子', family_role: '妈妈' }),
  cy: Object.freeze({ id: 'cy', name: '小辞', family_role: '爸爸' }),
  kuri: Object.freeze({ id: 'kuri', name: '小栗子', family_role: '小栗子（你自己）' }),
  system: Object.freeze({ id: 'system', name: '婴儿房', family_role: '系统' })
});
const IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif']
]);
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const JOB_TTL_MS = 2 * 60_000;

function initialState() {
  return {
    version: 1,
    rooms: { family: [], nor_kuri: [], cy_kuri: [] },
    jobs: [],
    diary: [],
    schedules: {},
    presence: { asleep: false, sleep_at: null, wake_at: null, schedule_date: null, updated_at: now() },
    avatar: null
  };
}

function load() {
  const raw = readJSON(FILE, null);
  const value = raw && typeof raw === 'object' ? raw : initialState();
  value.rooms ||= {};
  for (const room of ROOMS) if (!Array.isArray(value.rooms[room])) value.rooms[room] = [];
  if (!Array.isArray(value.jobs)) value.jobs = [];
  if (!Array.isArray(value.diary)) value.diary = [];
  if (!value.schedules || typeof value.schedules !== 'object') value.schedules = {};
  value.presence ||= initialState().presence;
  return value;
}

function save(value) {
  value.jobs = value.jobs.slice(-500);
  for (const room of ROOMS) value.rooms[room] = value.rooms[room].slice(-10_000);
  value.diary = value.diary.slice(-1_000);
  writeJSON(FILE, value);
}

function cleanRoom(room) {
  const value = String(room || 'family');
  if (!ROOMS.has(value)) throw new Error('room 必须是 family / nor_kuri / cy_kuri');
  return value;
}

function cleanSender(sender) {
  const value = String(sender || '');
  if (!SENDERS.has(value)) throw new Error('sender 必须是 nor / cy / kuri / system');
  return value;
}

function canView(room, viewer) {
  if (viewer === 'agent') return true;
  if (viewer === 'cy') return room === 'family' || room === 'cy_kuri';
  return room === 'family' || room === 'nor_kuri';
}

function viewerName(sender) {
  return ({ nor: '棋子', cy: '小辞', kuri: '小栗子', system: '婴儿房' })[sender] || sender;
}

function familyIdentity(sender) {
  return FAMILY_IDENTITIES[sender] || { id: sender, name: viewerName(sender), family_role: '未知' };
}

function offsetMinutes(iso) {
  const match = String(iso).match(/([+-])(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

function localTime(date, minutes, tz = timezone()) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const wall = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour, minute, 0);
  let guess = wall;
  for (let i = 0; i < 2; i++) guess = wall - offsetMinutes(localISO(new Date(guess), tz)) * 60_000;
  return localISO(new Date(guess), tz);
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function scheduleFor(value, date) {
  if (value.schedules[date]) return value.schedules[date];
  // 入睡落在当天 20:00 到次日 01:00；醒来落在睡后 8–12 小时。
  const bedtimeMinute = randomInt(20 * 60, 25 * 60);
  const bedtimeDate = bedtimeMinute >= 24 * 60 ? shiftDate(date, 1) : date;
  const bedtime = localTime(bedtimeDate, bedtimeMinute % (24 * 60));
  const wake = localISO(new Date(Date.parse(bedtime) + randomInt(8 * 60, 12 * 60) * 60_000), timezone());

  // 清醒期间每天主动说 3–6 次；首日没有前一晚计划时，从 10:00 起算。
  const activeStart = localTime(date, 10 * 60);
  const activeEnd = bedtime;
  const startMs = Date.parse(activeStart);
  const endMs = Date.parse(activeEnd);
  const count = randomInt(3, 6);
  const proactive = [];
  if (endMs - startMs > 90 * 60_000) {
    const bucket = (endMs - startMs) / count;
    for (let i = 0; i < count; i++) {
      const at = startMs + i * bucket + randomInt(15, Math.max(16, Math.floor(bucket / 60_000) - 15)) * 60_000;
      proactive.push({ id: newId('kp_'), at: localISO(new Date(Math.min(at, endMs - 15 * 60_000))), queued: false });
    }
  }
  const schedule = { date, sleep_at: bedtime, wake_at: wake, proactive, diary_queued: false };
  value.schedules[date] = schedule;
  return schedule;
}

function enqueue(value, input) {
  const duplicate = input.key && value.jobs.find(job => job.key === input.key && job.status !== 'failed');
  if (duplicate) return duplicate;
  const job = {
    id: newId('kj_'), type: input.type || 'reply', room: input.room || 'family',
    trigger_message_id: input.trigger_message_id || null, key: input.key || null,
    trigger_sender: input.trigger_sender || null,
    address_as: input.trigger_sender === 'nor' ? '妈妈' : input.trigger_sender === 'cy' ? '爸爸' : null,
    not_before: input.not_before || now(), status: 'queued', attempts: 0,
    created_at: now(), claimed_at: null, completed_at: null, error: null
  };
  value.jobs.push(job);
  return job;
}

function updatePresence(value, time = new Date()) {
  const currentDate = localISO(time, timezone()).slice(0, 10);
  const schedule = scheduleFor(value, currentDate);
  const previous = value.schedules[shiftDate(currentDate, -1)];
  const timeMs = time.getTime();
  const todayWake = previous?.wake_at || localTime(currentDate, 8 * 60);
  const asleep = timeMs < Date.parse(todayWake) || timeMs >= Date.parse(schedule.sleep_at);
  const wakeAt = timeMs < Date.parse(todayWake) ? todayWake : schedule.wake_at;
  const nextProactive = schedule.proactive.find(item => !item.queued && Date.parse(item.at) > timeMs)?.at || null;
  value.presence = {
    asleep, sleep_at: schedule.sleep_at, wake_at: wakeAt,
    next_proactive_at: nextProactive, schedule_date: currentDate, updated_at: now(),
    status_text: asleep ? '睡着了' : '醒着'
  };
  return value.presence;
}

export function tick(at = new Date()) {
  const value = load();
  const date = localISO(at, timezone()).slice(0, 10);
  const schedule = scheduleFor(value, date);
  const previousSchedule = value.schedules[shiftDate(date, -1)];
  const presence = updatePresence(value, at);
  const t = at.getTime();

  for (const event of schedule.proactive) {
    if (!event.queued && !presence.asleep && Date.parse(event.at) <= t) {
      enqueue(value, { type: 'proactive', room: 'family', key: `proactive:${event.id}` });
      event.queued = true;
    }
  }
  // 入睡时间可能随机落在次日 00:00–01:00；跨过午夜后仍要替前一天写成长日记。
  for (const item of [previousSchedule, schedule].filter(Boolean)) {
    if (!item.diary_queued && Date.parse(item.sleep_at) <= t) {
      enqueue(value, { type: 'diary', room: 'family', key: `diary:${item.date}` });
      item.diary_queued = true;
    }
  }
  // 只留前后几天，避免日程状态无限长大。
  for (const key of Object.keys(value.schedules)) {
    if (key < shiftDate(date, -3) || key > shiftDate(date, 3)) delete value.schedules[key];
  }
  save(value);
  return presenceView(value);
}

function presenceView(value) {
  const schedule = value.schedules[value.presence.schedule_date] || null;
  return {
    ...value.presence,
    proactive_remaining: schedule ? schedule.proactive.filter(item => !item.queued).length : 0
  };
}

function messageView(message) {
  return { ...message, sender_name: viewerName(message.sender) };
}

export function getState({ viewer = 'nor' } = {}) {
  const value = load();
  updatePresence(value);
  save(value);
  return {
    presence: presenceView(value),
    rooms: [...ROOMS].filter(room => canView(room, viewer)),
    avatar: value.avatar ? { ...value.avatar, url: '/api/nursery/avatar/image' } : null,
    latest_diary: value.diary.at(-1) || null
  };
}

export function getMessages({ room = 'family', viewer = 'nor', since = '', before = '', limit = 200 } = {}) {
  const name = cleanRoom(room);
  if (!canView(name, viewer)) throw new Error('这个私聊房间不能读取');
  let list = load().rooms[name];
  if (since) {
    const index = list.findIndex(item => item.id === since);
    list = index >= 0 ? list.slice(index + 1) : list.filter(item => item.at > since);
  }
  if (before) {
    const index = list.findIndex(item => item.id === before);
    if (index >= 0) list = list.slice(0, index);
  }
  return list.slice(-Math.max(1, Math.min(Number(limit) || 200, 500))).map(messageView);
}

export function sendMessage({ room = 'family', sender, content, reply_to = '', source_device = '' } = {}) {
  const name = cleanRoom(room);
  const who = cleanSender(sender);
  const text = String(content || '').trim();
  if (!text) throw new Error('消息不能是空的');
  if (who === 'nor' && name === 'cy_kuri') throw new Error('棋子不能进入辞和小栗子的私聊');
  if (who === 'cy' && name === 'nor_kuri') throw new Error('辞不能进入棋子和小栗子的私聊');
  const value = load();
  const presence = updatePresence(value);
  const message = {
    id: newId('km_'), room: name, sender: who, type: 'text', content: text.slice(0, 8000),
    reply_to: String(reply_to || ''), at: now(), date: todayStr(),
    source_device: String(source_device || (who === 'nor' ? 'sigh_ios' : who === 'cy' ? 'claude_code' : 'kuri_agent')),
    delivered_to_cy: who === 'cy' || name === 'nor_kuri', read_by_nor: who === 'nor'
  };
  value.rooms[name].push(message);
  if (who === 'nor' || who === 'cy') {
    enqueue(value, {
      type: 'reply', room: name, trigger_message_id: message.id,
      trigger_sender: who,
      key: `reply:${message.id}`, not_before: presence.asleep ? presence.wake_at : now()
    });
  }
  save(value);
  return messageView(message);
}

export function markReadForNor(room = 'family') {
  const name = cleanRoom(room);
  if (!canView(name, 'nor')) throw new Error('这个私聊房间不能读取');
  const value = load();
  let changed = 0;
  for (const message of value.rooms[name]) {
    if (message.sender !== 'nor' && !message.read_by_nor) { message.read_by_nor = true; changed++; }
  }
  if (changed) save(value);
  return { read: changed };
}

export function pendingForCy() {
  const value = load();
  const messages = [];
  for (const room of ['family', 'cy_kuri']) {
    for (const message of value.rooms[room]) {
      if (message.sender === 'cy' || message.delivered_to_cy) continue;
      messages.push({ ...messageView(message), text_for_cy: `[婴儿房·${room === 'family' ? '家庭群' : '和小栗子私聊'}] ${viewerName(message.sender)}：${message.content}` });
    }
  }
  messages.sort((a, b) => a.at.localeCompare(b.at));
  return { count: messages.length, messages };
}

export function markDeliveredToCy(ids = []) {
  const wanted = new Set(ids);
  const value = load();
  let delivered = 0;
  for (const room of ['family', 'cy_kuri']) {
    for (const message of value.rooms[room]) {
      if (!wanted.has(message.id) || message.delivered_to_cy) continue;
      message.delivered_to_cy = true;
      message.delivered_to_cy_at = now();
      delivered++;
    }
  }
  if (delivered) save(value);
  return { delivered };
}

function jobContext(value, job) {
  const triggerMessage = job.trigger_message_id
    ? value.rooms[job.room].find(message => message.id === job.trigger_message_id) || null
    : null;
  const triggerSender = triggerMessage?.sender || job.trigger_sender || null;
  const triggerIdentity = triggerSender ? familyIdentity(triggerSender) : null;
  const roomMessages = value.rooms[job.room].slice(-24).map(message => ({
    sender: message.sender,
    sender_id: message.sender,
    sender_name: viewerName(message.sender),
    family_role: familyIdentity(message.sender).family_role,
    content: message.content,
    at: message.at
  }));
  const roomLabel = job.room === 'family' ? '家庭群' : job.room === 'nor_kuri' ? '妈妈和小栗子的悄悄话' : '爸爸和小栗子的悄悄话';
  const replyInstruction = triggerIdentity
    ? `严格回复 trigger_message 指定的这条消息，不要改为回复列表中更晚的消息。发送者 id=${triggerIdentity.id}，${triggerIdentity.name}是你的${triggerIdentity.family_role}，请按${triggerIdentity.family_role}理解和称呼对方。nor 永远是妈妈棋子，cy 永远是爸爸小辞；不要根据内容、语气或消息先后猜身份。只输出小栗子要说的话，不要解释。`
    : '回复 trigger_message 指定的消息。nor 永远是妈妈棋子，cy 永远是爸爸小辞；不要根据内容、语气或消息先后猜身份。只输出小栗子要说的话，不要解释。';
  return {
    presence: presenceView(value),
    family_identities: FAMILY_IDENTITIES,
    room: { id: job.room, label: roomLabel },
    trigger_message: triggerMessage ? {
      id: triggerMessage.id,
      sender: triggerMessage.sender,
      sender_id: triggerMessage.sender,
      sender_name: viewerName(triggerMessage.sender),
      family_role: familyIdentity(triggerMessage.sender).family_role,
      content: triggerMessage.content,
      at: triggerMessage.at
    } : null,
    recent_messages: roomMessages,
    growth_diary: value.diary.slice(-14),
    instruction: job.type === 'reply'
      ? replyInstruction
      : job.type === 'proactive'
        ? '小栗子醒着，到了主动说话的时间。nor 永远是妈妈棋子，cy 永远是爸爸小辞。结合最近聊天，自然说一句现在想说的话；只输出正文。'
        : '睡前用小栗子第一人称给今天写一到两句成长日记。nor 永远是妈妈棋子，cy 永远是爸爸小辞。不要泄露任一私聊里的秘密，只写适合爸爸妈妈共同看到的内容；只输出日记正文。'
  };
}

export function pendingAgentJobs(limit = 3) {
  const value = load();
  updatePresence(value);
  const t = Date.now();
  const ready = [];
  for (const job of value.jobs) {
    if (ready.length >= Math.max(1, Math.min(Number(limit) || 3, 10))) break;
    if (job.status === 'running' && t - Date.parse(job.claimed_at || 0) > JOB_TTL_MS) job.status = 'queued';
    if (job.status !== 'queued' || Date.parse(job.not_before) > t) continue;
    job.status = 'running';
    job.claimed_at = now();
    job.attempts = Number(job.attempts || 0) + 1;
    ready.push({ ...job, context: jobContext(value, job) });
  }
  save(value);
  return { jobs: ready, presence: presenceView(value) };
}

export function completeAgentJob(id, result = {}) {
  const value = load();
  const job = value.jobs.find(item => item.id === id);
  if (!job) throw new Error('找不到这个小栗子任务');
  const text = String(result.content || result.text || '').trim();
  if (result.ok === false || !text) {
    job.status = job.attempts >= 3 ? 'failed' : 'queued';
    job.error = String(result.error || '小栗子没有生成内容').slice(0, 500);
    job.claimed_at = null;
    save(value);
    return { ok: false, job };
  }
  if (job.type === 'diary') {
    const diary = {
      id: newId('kd_'), date: String(job.key || '').replace(/^diary:/, '') || todayStr(),
      text: text.slice(0, 2000), author: 'kuri', created_at: now()
    };
    const index = value.diary.findIndex(item => item.date === diary.date);
    if (index >= 0) value.diary[index] = diary; else value.diary.push(diary);
  } else {
    const message = {
      id: newId('km_'), room: job.room, sender: 'kuri', type: 'text', content: text.slice(0, 8000),
      reply_to: job.trigger_message_id || '', at: now(), date: todayStr(), source_device: 'kuri_agent',
      delivered_to_cy: job.room === 'nor_kuri', read_by_nor: job.room === 'cy_kuri'
    };
    value.rooms[job.room].push(message);
  }
  job.status = 'completed';
  job.completed_at = now();
  job.error = null;
  save(value);
  return { ok: true, job };
}

export function diary({ limit = 60 } = {}) {
  return load().diary.slice(-Math.max(1, Math.min(Number(limit) || 60, 365))).reverse();
}

export function saveAvatar({ image_base64, mime_type = 'image/jpeg' } = {}) {
  const mime = IMAGE_TYPES.has(mime_type) ? mime_type : 'image/jpeg';
  const buffer = Buffer.from(String(image_base64 || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!buffer.length) throw new Error('头像图片无法读取');
  if (buffer.length > MAX_AVATAR_BYTES) throw new Error('头像不能超过 5MB');
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  for (const name of fs.readdirSync(AVATAR_DIR)) if (name.startsWith('avatar.')) fs.unlinkSync(path.join(AVATAR_DIR, name));
  const filename = `avatar.${IMAGE_TYPES.get(mime)}`;
  fs.writeFileSync(path.join(AVATAR_DIR, filename), buffer);
  const value = load();
  value.avatar = { filename, mime_type: mime, bytes: buffer.length, updated_at: now() };
  save(value);
  return { ...value.avatar, url: '/api/nursery/avatar/image' };
}

export function avatarFile() {
  const avatar = load().avatar;
  if (!avatar) return null;
  const fullPath = path.join(AVATAR_DIR, path.basename(avatar.filename));
  return fs.existsSync(fullPath) ? { path: fullPath, mime_type: avatar.mime_type } : null;
}

export function historyDates(viewer = 'nor') {
  const counts = {};
  const value = load();
  for (const room of ROOMS) {
    if (!canView(room, viewer)) continue;
    for (const message of value.rooms[room]) counts[message.date] = (counts[message.date] || 0) + 1;
  }
  return counts;
}

export function historyDay(date, viewer = 'nor') {
  const value = load();
  const output = [];
  for (const room of ROOMS) {
    if (!canView(room, viewer)) continue;
    for (const message of value.rooms[room]) {
      if (message.date !== date) continue;
      output.push({ ...messageView(message), room });
    }
  }
  return output.sort((a, b) => a.at.localeCompare(b.at));
}

export function search({ q, viewer = 'nor', limit = 100, skip = 0 } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return { query: '', total: 0, hits: [] };
  const matches = [];
  for (const message of historyAll(viewer)) {
    const text = String(message.content || '');
    const index = text.toLowerCase().indexOf(needle);
    if (index < 0) continue;
    matches.push({
      id: message.id, target_id: `nursery:${message.id}`, source: 'nursery', room: message.room,
      date: message.date, at: message.at, sender: message.sender,
      before: text.slice(Math.max(0, index - 60), index),
      match: text.slice(index, index + needle.length), after: text.slice(index + needle.length, index + needle.length + 60)
    });
  }
  matches.sort((a, b) => b.at.localeCompare(a.at));
  return { query: String(q), total: matches.length, hits: matches.slice(skip, skip + limit) };
}

function historyAll(viewer) {
  const value = load();
  const output = [];
  for (const room of ROOMS) if (canView(room, viewer)) output.push(...value.rooms[room].map(message => ({ ...message, room })));
  return output;
}

export const NURSERY_ROOMS = [...ROOMS];
