import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import {
  getState, updateSettings, getShelf, removeBook,
  getNotes, getLog, getBookContent, setProgress, addNote
} from './lib/store.js';
import { searchGutenberg, addFromGutenberg, addFromUpload } from './lib/books.js';
import { planToday } from './lib/ci.js';
import { getQuestions, askQuestion, replyToQuestion, resolveQuestion } from './lib/memory.js';
import * as mw from './lib/muwen/index.js';
import { runNegativeMemoryCleanup20261017 } from './lib/muwen/cleanup-negative-memory-2026-10-17.js';
import { handleMcpRequest } from './lib/mcp.js';
import { mountOAuth } from './lib/oauth-routes.js';
import { checkToken as checkOAuthToken } from './lib/oauth.js';
import { getPendingSpeech, markSpeechDone } from './lib/speech.js';
import { getVoiceHistory, getVoiceFilePath, streamSpeech } from './lib/voice.js';
import {
  backupStorageConfig, listCiHoursBackups, uploadCiHoursBackup
} from './lib/backup-storage.js';
import { addTranscript, getTranscripts, searchTranscripts, getTranscriptById, getDailySummariesByMonth } from './lib/transcripts.js';
import { addDiaryEntry, getDiaryPublic } from './lib/diary.js';
import { publicLabels } from './lib/muwen/labels.js';
import { leaveMessage, getMessages } from './lib/messages.js';
import { playFishing } from './lib/fishing.js';
import { sendPush, getPushConfig, registerPushDevice, removePushDevice } from './lib/bark.js';
import * as windowWorkbench from './lib/window-workbench.js';
import {
  addSchedule, getSchedule, updateSchedule, completeSchedule, removeSchedule, getDueSchedules, markSchedulePushed,
  getScheduleByMonth, getScheduleForDate
} from './lib/schedule.js';
import {
  addCycleEntry, getCycleEntries, updateCycleEntry, removeCycleEntry,
  addSleepEntry, getSleepEntries, updateSleepEntry, removeSleepEntry,
  addHealthNote, getHealthNotes, updateHealthNote, removeHealthNote
} from './lib/health.js';
import { getWheels, createWheel, updateWheel, removeWheel, spinWheel, getBoardNotes, createBoardNote, updateBoardNote, archiveBoardNote, restoreBoardNote } from './lib/shared-spaces.js';
import { getLocationState, updateLocation, addLocationPlace, updateLocationPlace, removeLocationPlace } from './lib/location.js';
import { getPhoneUsage, ingestPhoneUsage } from './lib/phone-usage.js';
import {
  getWatchHealth, ingestWatchHealth, getWatchStatus, requestWatchRefresh,
  pendingWatchActions, completeWatchAction
} from './lib/watch-health.js';
import {
  enqueueWatchCommand, nextWatchCommand, acknowledgeWatchCommand, watchCommandStatus,
  watchEventReceipt, recordWatchEventReceipt
} from './lib/watch-cloud.js';
import {
  getPetHousehold, getPet, careForPet,
  syncPetNest, pendingPetActions, completePetAction
} from './lib/pet-nest.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 木纹：启动时把 ci-hours 的 memory.json 迁进 grains/profiles（只跑一次，旧文件原样保留当备份）
mw.migrate.migrateIfNeeded();
runNegativeMemoryCleanup20261017();

const app = express();
app.set('trust proxy', true); // Render 在代理后面，这样 req.protocol 才能正确识别 https
app.use(express.json({ limit: '80mb' })); // 聊天允许一条最多 10 张；业务层另外限制单张和总大小。
// 好让超限时报的是 album.js 里那句人话（'先在手机上裁一下'），而不是 express 的 413 HTML。后端会再自动压到 2MB 存
app.use((req, res, next) => {
  if (req.path === '/muwu' || req.path === '/muwu.html' || req.path === '/chat.js') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
// 两个前端：/ = 木纹（记忆），/muwu = 木屋（生活）。共用同一套后端和 /mcp。
app.get('/muwu', (_, res) => res.sendFile(path.join(__dirname, 'public', 'muwu.html')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });
// ---- 跨域许可：给浏览器里直接发请求的场景用（比如调试面板、未来的网页小工具）----
// 放在密码校验前面，让 OPTIONS 预检请求不会被密码卡住。
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-access-token, x-window-agent-key, x-muwu-session-id');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
// ---- OAuth 相关端点：挂在密码中间件之前，这些接口自己管认证（授权页本身就是用密码确认的） ----
mountOAuth(app);
// ---- 简单的密码保护 ----
// token 可以从三个地方拿：自定义头 x-access-token、标准的 Authorization: Bearer、
// 或者直接拼在 URL 里 ?token=xxx（给静态密码模式用，配置起来最省事）。
// Bearer 那里额外接受 OAuth 授权流程签发的 token，两套认证并存，互不影响。
const PASSWORD = process.env.ACCESS_PASSWORD;
app.use((req, res, next) => {
  if (!PASSWORD) return next();
  if (req.path === '/health' || req.path === '/login.html') return next();
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = req.headers['x-access-token'] || bearerToken || req.query.token;
  if (token === PASSWORD) return next();
  if (bearerToken && checkOAuthToken(bearerToken)) return next();
  if (req.path === '/' || req.path.endsWith('.html') || req.path.endsWith('.css')) return next();
  return res.status(401).json({ error: '需要密码' });
});
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// 棋子控制“辞能不能进入完整木屋”的总开关。它只限制辞的 MCP 与消息投递，
// 不限制棋子自己的 Sigh / 木屋前端，所以关掉以后仍然能在手机上正常整理内容。
app.get('/api/agent-access', (_, res) => res.json(mw.agentAccess.getAgentAccess()));
app.post('/api/agent-access', (req, res) => {
  try { res.json(mw.agentAccess.setAgentAccess(req.body || {}, '棋子·Sigh')); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ---- 私有云备份：Mac mini 每周把本地整库 gzip 再镜像一份到 Supabase Storage ----
// 入口位于密码中间件之后；Supabase service key 永远只留在 Render 环境里。
app.get('/api/backups/status', async (req, res) => {
  try { res.json(await listCiHoursBackups(req.query.limit)); }
  catch (e) { res.status(502).json({ error: String(e.message || e), ...backupStorageConfig() }); }
});
app.post('/api/backups/upload', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '缺少 backup 文件' });
    res.json(await uploadCiHoursBackup({
      filename: req.file.originalname,
      buffer: req.file.buffer
    }));
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

function deliveryRoute(req) {
  const sessionId = req.headers['x-muwu-session-id']
    || req.query.session_id
    || (req.body && req.body.session_id);
  return windowWorkbench.deliveryRoute(sessionId);
}

function agentDeliveryRoute(req) {
  const route = deliveryRoute(req);
  if (!route.allowed) return route;
  if (!mw.agentAccess.deliveryAllowed()) {
    return { ...route, allowed: false, reason: 'agent_memory_only' };
  }
  return route;
}

function blockedDelivery(route, kind) {
  const base = { blocked: true, reason: route.reason };
  return kind === 'call'
    ? { ...base, call: null, events: [] }
    : { ...base, count: 0, messages: [] };
}
// ---- 状态 ----
app.get('/api/state', (_, res) => {
  const s = getState();
  res.json({
    settings: s.settings,
    today: s.today,
    plannedWakes: s.plannedWakes,
    doneWakes: s.doneWakes,
    chaptersReadToday: s.chaptersReadToday
  });
});
app.post('/api/settings', (req, res) => {
  const allowed = ['maxWakesPerDay', 'maxChaptersPerDay', 'quietHoursStart', 'quietHoursEnd', 'timezone'];
  const patch = {};
  for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k];
  res.json(updateSettings(patch));
});
// ---- 书库 ----
app.get('/api/shelf', (_, res) => res.json(getShelf()));
app.get('/api/shelf/check', async (_, res) => {
  try { const { checkShelfEncoding } = await import('./lib/books.js'); res.json(checkShelfEncoding()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/shelf/formats', async (_, res) => {
  const { SUPPORTED_FORMATS } = await import('./lib/books.js');
  res.json({ formats: SUPPORTED_FORMATS });
});
app.get('/api/search-gutenberg', async (req, res) => {
  try {
    res.json(await searchGutenberg(req.query.q || ''));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/add-gutenberg', async (req, res) => {
  try {
    res.json(await addFromGutenberg(req.body));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '没有收到文件' });
    res.json(await addFromUpload(req.file.buffer, req.file.originalname));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.delete('/api/book/:id', (req, res) => { removeBook(req.params.id); res.json({ ok: true }); });
app.get('/api/book/:id', (req, res) => {
  const c = getBookContent(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到' });
  // 旧网页没传分页参数时仍只拿目录；原生阅读器按章取正文，避免一次下载整本书。
  if (req.query.from !== undefined || req.query.count !== undefined) {
    const from = Math.max(0, Number(req.query.from) || 0);
    const count = Math.max(1, Math.min(10, Number(req.query.count) || 1));
    return res.json({
      id: c.id,
      title: c.title,
      from,
      totalChapters: c.chapters.length,
      chapters: c.chapters.slice(from, from + count)
    });
  }
  res.json({ id: c.id, title: c.title, chapters: c.chapters.map(ch => ch.title) });
});
app.post('/api/book/:id/progress', (req, res) => {
  const book = getShelf().find(x => x.id === req.params.id);
  if (!book) return res.status(404).json({ error: '找不到这本书' });
  const progress = Math.max(0, Math.min(book.totalChapters, Number(req.body && req.body.progress) || 0));
  setProgress(book.id, progress);
  res.json({ ...book, progress, finished: progress >= book.totalChapters });
});
// ---- 记录与日志 ----
app.get('/api/notes', (req, res) => {
  let notes = getNotes(Number(req.query.limit) || 200);
  if (req.query.kind) notes = notes.filter(x => x.kind === req.query.kind);
  if (req.query.bookId) notes = notes.filter(x => x.bookId === req.query.bookId);
  res.json(notes);
});
app.post('/api/book/:id/notes', (req, res) => {
  const book = getShelf().find(x => x.id === req.params.id);
  if (!book) return res.status(404).json({ error: '找不到这本书' });
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: '笔记不能为空' });
  const chapters = Array.isArray(req.body && req.body.chapters)
    ? req.body.chapters.map(Number).filter(Number.isInteger)
    : [];
  res.json(addNote({ kind: 'read', text, bookId: book.id, bookTitle: book.title, chapters, addedBy: '棋子' }));
});
app.get('/api/log', (_, res) => res.json(getLog(200)));
// ---- 木纹：记忆三层 + 档案 + 倒数日 + 心情 + 相册（网页只读，写入走 /mcp）----
app.get('/api/memory', (_, res) => {
  // 旧接口兼容：按旧分类名分组的前台记忆 + 档案。新页面用下面的 /api/grains /api/profiles。
  const { grains, notes } = mw.grains.getActiveMemories();
  const LEGACY = { experience: 'experiences', agreement: 'agreements', feeling: 'feelings', learning: 'learnings', to_self: 'toSelf', unexplained: 'unexplained' };
  const out = { identity: [], feelings: [], facts: [], experiences: [], learnings: [], openThreads: [], toSelf: [], agreements: [], unexplained: [], notes };
  for (const g of grains) out[LEGACY[g.category]].push(g);
  out.identity = mw.profiles.getProfile('cy').filter(p => p.content).map(p => ({ id: p.id, text: p.content, field: p.field, status: 'active' }));
  out.facts = mw.profiles.getProfile('nor').filter(p => p.content).map(p => ({ id: p.id, text: p.content, field: p.field }));
  res.json(out);
});
app.get('/api/grains', (req, res) => {
  const { category, status, family, q } = req.query;
  const limit = Number(req.query.limit) || 200;
  const sort = mw.grains.SORTS.includes(req.query.sort) ? req.query.sort : 'heat';
  res.json(mw.grains.searchGrains({ query: q || '', category: category || undefined, status: status || undefined, family: family || undefined, limit, touchHits: false, sort }));
});
app.get('/api/grains/families', (_, res) => res.json(mw.grains.listFamilies()));
app.get('/api/grains/stats', (_, res) => res.json(mw.grains.countByStatus()));
app.get('/api/grains/:id', (req, res) => {
  const g = mw.grains.getGrain(req.params.id, { touchIt: false });
  if (!g) return res.status(404).json({ error: '找不到' });
  res.json({ ...g, links: mw.grains.getLinks(g.id) });
});
// 网页不能直接改正式记忆，只能提出版本化修改。正式 apply 只开放给辞的 MCP 工具。
app.get('/api/memory-revisions', (req, res) => {
  res.json({
    counts: mw.memoryRevisions.counts(),
    proposals: mw.memoryRevisions.listProposals({ status: req.query.status || '', limit: Number(req.query.limit) || 200 })
  });
});
app.get('/api/memory-revisions/:id', (req, res) => {
  const proposal = mw.memoryRevisions.getProposal(req.params.id);
  if (!proposal) return res.status(404).json({ error: '找不到这份修改提案' });
  res.json(proposal);
});
app.post('/api/memory-revisions', async (req, res) => {
  try {
    const body = req.body || {};
    const proposal = body.target_type === 'profile' || (body.owner && body.field)
      ? mw.memoryRevisions.createProfileProposal({ ...body, actor: 'nor' })
      : mw.memoryRevisions.createProposal({ ...body, actor: 'nor' });
    res.json(proposal);
    await mw.chat.sendSystemEvent(
      `棋子提出了一份${proposal.target_type === 'profile' ? '档案' : '记忆'}修改建议（${proposal.id}）。`,
      'memory_revision_proposed',
      {
        deliverToCy: true,
        deliveryKey: `memory_revision:${proposal.id}`,
        deliveryText: `棋子建议修改${proposal.target_type === 'profile' ? `档案「${proposal.target_label}」` : '一条记忆'}。提案 id=${proposal.id}。请用 memory_revision_get 查看修改前后和理由，再用 memory_revision_decide 同意、否决或提出你的版本。`,
        sourceDevice: 'memory_revision'
      }
    );
  } catch (e) { if (!res.headersSent) res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/memory-revisions/:id/update', (req, res) => {
  try { res.json(mw.memoryRevisions.updateProposal(req.params.id, { ...(req.body || {}), actor: 'nor' })); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/memory-revisions/:id/withdraw', (req, res) => {
  try { res.json(mw.memoryRevisions.withdrawProposal(req.params.id, { actor: 'nor', note: (req.body || {}).note || '' })); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/memory-revisions/:id/rollback', async (req, res) => {
  try {
    const proposal = mw.memoryRevisions.requestRollback(req.params.id, { actor: 'nor', reason: (req.body || {}).reason || '' });
    res.json(proposal);
    await mw.chat.sendSystemEvent(
      `棋子建议撤销一次已经生效的记忆修改（${proposal.id}）。`,
      'memory_revision_rollback',
      {
        deliverToCy: true,
        deliveryKey: `memory_revision:${proposal.id}`,
        deliveryText: `棋子建议撤销一次记忆修改。提案 id=${proposal.id}。请用 memory_revision_get 查看，再用 memory_revision_decide 决定。`,
        sourceDevice: 'memory_revision'
      }
    );
  } catch (e) { if (!res.headersSent) res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/profiles', (_, res) => res.json({ cy: mw.profiles.getProfile('cy'), nor: mw.profiles.getProfile('nor') }));
app.get('/api/profiles/:owner/:field/history', (req, res) => {
  try { res.json(mw.profiles.getProfileHistory(req.params.owner, req.params.field)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/countdowns', (_, res) => res.json(mw.countdowns.getCountdowns()));
app.post('/api/countdowns', (req, res) => {
  try { const b = req.body || {}; res.json(mw.countdowns.addCountdown(b.title, b.date, b.recurring, { note: b.note, photo_id: b.photo_id })); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/countdowns/:id', (req, res) => {
  try { const c = mw.countdowns.updateCountdown(req.params.id, req.body || {}); if (!c) return res.status(404).json({ error: '找不到' }); res.json(c); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/push-history', async (req, res) => {
  const { getPushHistory } = await import('./lib/bark.js');
  res.json(getPushHistory(Number(req.query.limit) || 100));
});
app.get('/api/push/config', (_, res) => res.json(getPushConfig()));
app.post('/api/push/devices', (req, res) => {
  try { res.json(registerPushDevice(req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.delete('/api/push/devices/:token', (req, res) => res.json(removePushDevice(req.params.token)));
app.get('/api/fishing/encyclopedia', async (_, res) => {
  try { res.json({ text: await playFishing('encyclopedia') }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/moods', (req, res) => res.json(mw.moods.getMoods({ limit: Number(req.query.limit) || 50 })));
app.get('/api/album', (req, res) => res.json(mw.album.listPhotos({ category: req.query.category || '', limit: Number(req.query.limit) || 100 })));
app.get('/api/album-categories', (_, res) => res.json(mw.album.listPhotoCategories()));
app.get('/api/album/:id/image', (req, res) => {
  const meta = mw.album.getPhotoMeta(req.params.id);
  const p = mw.album.getPhotoPath(req.params.id);
  if (!meta || !p) return res.status(404).json({ error: '找不到这张照片' });
  res.setHeader('Content-Type', meta.preview_mime_type || meta.mime_type);
  res.setHeader('Cache-Control', 'private, max-age=604800');
  fs.createReadStream(p).pipe(res);
});
app.get('/api/album/:id/original', (req, res) => {
  const meta = mw.album.getPhotoMeta(req.params.id);
  const p = mw.album.getPhotoOriginalPath(req.params.id);
  if (!meta || !p) return res.status(404).json({ error: '找不到这张照片的原图' });
  res.setHeader('Content-Type', meta.original_mime_type || meta.mime_type);
  res.setHeader('Cache-Control', 'private, max-age=604800');
  fs.createReadStream(p).pipe(res);
});
app.delete('/api/album/:id', (req, res) => {
  try {
    const meta = mw.album.getPhotoMeta(req.params.id);
    if ((meta?.tags || []).includes('辞的表情包')) {
      return res.status(403).json({ error: '辞的表情包由辞自己管理。' });
    }
    const photo = mw.album.deletePhoto(req.params.id);
    if (!photo) return res.status(404).json({ error: '找不到这张照片' });
    res.json({ ok: true, deleted: photo });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/handover', (_, res) => res.json(mw.handover.getHandover() || {}));
app.get('/api/wake-packet', (_, res) => res.json(mw.wake.getWakePacket()));
app.get('/api/kiss-progress', (_, res) => res.json({ ...mw.rings.kissProgress(), days: mw.rings.kissHistory() }));
app.get('/api/emotions', (req, res) => res.json(mw.emotions.getEmotions({ withHits: req.query.mentions === '1' })));
app.get('/api/emotions/:id', (req, res) => {
  const e = mw.emotions.getEmotion(req.params.id);
  if (!e) return res.status(404).json({ error: '没有这条情绪' });
  res.json(e);
});
app.get('/api/songs', (req, res) => res.json(mw.songs.getSongs({ full: req.query.full === '1' })));
app.get('/api/songs/:id', (req, res) => {
  const s = mw.songs.getSong(req.params.id);
  if (!s) return res.status(404).json({ error: '没有这首歌' });
  res.json(s);
});

// ---- 后台低功耗定位：手机上传显著位置变化，后端匹配常用地点并写聊天系统动态 ----
app.get('/api/location', (_, res) => res.json(getLocationState({ exact: true })));
app.post('/api/location', async (req, res) => {
  try { res.json(await updateLocation(req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/location/places', (req, res) => {
  try { res.json(addLocationPlace(req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/location/places/:id', (req, res) => {
  try {
    const place = updateLocationPlace(req.params.id, req.body || {});
    if (!place) return res.status(404).json({ error: '找不到这个常用地点' });
    res.json(place);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/location/places/:id/remove', (req, res) => {
  const result = removeLocationPlace(req.params.id);
  if (!result) return res.status(404).json({ error: '找不到这个常用地点' });
  res.json(result);
});

// ---- iPhone 屏幕使用时间：Sigh 经系统授权后上传当天汇总；与“最近打开 App”脚本分开 ----
app.get('/api/phone-usage', (req, res) => res.json(getPhoneUsage(String(req.query.date || ''))));
app.post('/api/phone-usage', (req, res) => {
  try { res.json(ingestPhoneUsage(req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ---- Apple Watch relay：可由同机 relay 读取，也可由 Mac mini 主动推送一份快照 ----
app.get('/api/watch-health', async (req, res) => {
  try { res.json(await getWatchHealth({ refresh: req.query.refresh !== '0' })); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});
app.post('/api/watch-health/sync', (req, res) => {
  try {
    const source = req.headers['x-watch-source'] === 'sigh_watch' ? 'sigh_watch_direct' : 'watch_relay_push';
    res.json(ingestWatchHealth(req.body || {}, source));
  }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/watch-status', (_, res) => res.json(getWatchStatus()));
app.post('/api/watch-refresh', (_, res) => res.json(requestWatchRefresh()));
app.get('/api/watch-health/agent/actions', (req, res) => res.json(pendingWatchActions(Number(req.query.limit) || 20)));
app.post('/api/watch-health/agent/actions/:id/complete', (req, res) => {
  const action = completeWatchAction(req.params.id, req.body || {});
  if (!action) return res.status(404).json({ error: '找不到这个手表操作' });
  res.json(action);
});
app.post('/api/watch-commands', (req, res) => {
  try { res.json(enqueueWatchCommand(req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/watch-commands/next', (req, res) => {
  res.json({ command: nextWatchCommand(req.query.after || '') });
});
app.post('/api/watch-commands/:id/ack', (req, res) => {
  const command = acknowledgeWatchCommand(req.params.id, req.body || {});
  if (!command) return res.status(404).json({ error: '找不到这个手表指令' });
  res.json({ ok: true, ...watchCommandStatus(command.id) });
});
app.get('/api/watch-commands/:id/status', (req, res) => {
  const status = watchCommandStatus(req.params.id);
  if (!status) return res.status(404).json({ error: '找不到这个手表指令' });
  res.json({ ok: true, ...status });
});

// ---- Cove Pet Nest：Mac mini 主动同步 localhost:9480，照料动作由固定用途代理领走执行 ----
app.get('/api/pet-nest/household', async (_, res) => {
  try { res.json(await getPetHousehold()); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});
app.get('/api/pet-nest/pets/:id', async (req, res) => {
  try { res.json(await getPet(req.params.id)); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});
app.post('/api/pet-nest/pets/:id/care', async (req, res) => {
  try { res.json(await careForPet(req.params.id, String((req.body || {}).action || ''))); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ---- 婴儿房：家庭群、双方私聊、小栗子作息与成长日记 ----
// 手机端身份固定为棋子；辞只通过 MCP；小栗子只通过 Mac mini 的固定用途代理。
app.get('/api/nursery/state', (req, res) => {
  try { res.json(mw.nursery.getState({ viewer: 'nor' })); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/nursery/messages', (req, res) => {
  try {
    res.json(mw.nursery.getMessages({
      room: req.query.room || 'family', viewer: 'nor', since: req.query.since || '',
      before: req.query.before || '', limit: Number(req.query.limit) || 200
    }));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/nursery/messages', (req, res) => {
  try {
    res.json(mw.nursery.sendMessage({
      ...(req.body || {}), sender: 'nor', source_device: 'sigh_ios'
    }));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/nursery/read', (req, res) => {
  try { res.json(mw.nursery.markReadForNor((req.body || {}).room || 'family')); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/nursery/diary', (req, res) => {
  res.json(mw.nursery.diary({ limit: Number(req.query.limit) || 60 }));
});
app.post('/api/nursery/avatar', (req, res) => {
  try { res.json(mw.nursery.saveAvatar(req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/nursery/avatar/image', (req, res) => {
  const avatar = mw.nursery.avatarFile();
  if (!avatar) return res.status(404).end();
  res.type(avatar.mime_type).sendFile(path.resolve(avatar.path));
});

// 当前主要 Claude session 的 channel 轮询这一组；family 与 cy_kuri 才会投递给辞。
app.get('/api/nursery/pending', (req, res) => {
  const route = agentDeliveryRoute(req);
  res.json(route.allowed ? mw.nursery.pendingForCy() : blockedDelivery(route, 'chat'));
});
app.post('/api/nursery/delivered', (req, res) => {
  const route = agentDeliveryRoute(req);
  if (!route.allowed) return res.json({ delivered: 0, blocked: true, reason: route.reason });
  try { res.json(mw.nursery.markDeliveredToCy((req.body || {}).ids || [])); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Mac mini 小栗子代理：领取任务、调用本地 Ollama、交回纯文本结果。
app.get('/api/nursery/agent/jobs', (req, res) => {
  try { res.json(mw.nursery.pendingAgentJobs(Number(req.query.limit) || 3)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/nursery/agent/jobs/:id/complete', (req, res) => {
  try { res.json(mw.nursery.completeAgentJob(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/songs', (req, res) => {
  try { res.json(mw.songs.addSong({ ...(req.body || {}), added_by: (req.body || {}).added_by || '棋子' })); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/songs/:id', (req, res) => {
  const s = mw.songs.updateSong(req.params.id, req.body || {});
  if (!s) return res.status(404).json({ error: '没有这首歌' });
  res.json(s);
});
app.get('/api/firsts', (req, res) => res.json(mw.firsts.getFirsts({ limit: Number(req.query.limit) || 200 })));
app.get('/api/chat', (req, res) => {
  res.json(mw.chat.getMessages({
    since: req.query.since || '', before: req.query.before || '',
    limit: Math.min(Number(req.query.limit) || 200, 500),
    starred: req.query.starred === '1',
    starred_for: ['nor', 'cy'].includes(req.query.starred_for) ? req.query.starred_for : ''
  }));
});
const NOR_STICKER_TAG = '棋子的表情包';
const CY_STICKER_TAG = '辞的表情包';
const LEGACY_STICKER_TAG = '表情包';
app.get('/api/chat/stickers', (_, res) => {
  const all = mw.album.listPhotos({ limit: 5000 });
  res.json({
    nor: all.filter(p => (p.tags || []).includes(NOR_STICKER_TAG)
      || ((p.tags || []).includes(LEGACY_STICKER_TAG) && !(p.tags || []).includes(CY_STICKER_TAG))),
    cy: all.filter(p => (p.tags || []).includes(CY_STICKER_TAG))
  });
});
// 手机端只能把自己的表情包移出自己的库。辞的删除权只在 MCP sticker_delete。
app.delete('/api/chat/stickers/:id', (req, res) => {
  const p = mw.album.getPhotoMeta(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到这张表情包' });
  const tags = p.tags || [];
  const owns = tags.includes(NOR_STICKER_TAG)
    || (tags.includes(LEGACY_STICKER_TAG) && !tags.includes(CY_STICKER_TAG));
  if (!owns) return res.status(403).json({ error: '辞的表情包由辞自己添加和删除。' });
  res.json(mw.album.removePhotoTags(req.params.id, [NOR_STICKER_TAG, LEGACY_STICKER_TAG]));
});
app.get('/api/chat/unread', (req, res) => res.json(mw.chat.unreadSummary(req.query.who === 'cy' ? 'cy' : 'nor')));
app.post('/api/chat', async (req, res) => {
  // 棋子发消息走这里，不经过 MCP。网页上发的一律算棋子的——辞说话只能走 MCP 的 chat_reply，
  // 跟状态文字一个道理：两边各自的入口卡住，网页冒充不了辞。
  try {
    const b = req.body || {};
    res.json(await mw.chat.sendMessage({ ...b, sender: 'nor', thinking: '', tools: [], voice_id: '' }));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// 默认保持旧行为：Claude 原话只是只读 💭。棋子明确打开自动同步后，同一个 Stop hook
// 把最终正文变成正常气泡，并把该回合已有的 thinking/tools 一起挂上；不再要求 chat_reply。
app.get('/api/chat/sync-settings', (_, res) => res.json(mw.chat.getSyncSettings()));
app.post('/api/chat/sync-settings', (req, res) => {
  try { res.json(mw.chat.setSyncSettings(req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/chat/claude-mirror', async (req, res) => {
  try {
    const route = agentDeliveryRoute(req);
    if (!route.allowed) return res.status(409).json({ mirrored: false, blocked: true, reason: route.reason });
    const b = req.body || {};
    const content = String(b.content || '').trim();
    if (!content) return res.status(400).json({ error: 'content 不能为空' });
    const autoSync = mw.chat.getSyncSettings().auto_sync_reply === true;
    const fromMuwu = b.from_muwu === true;
    // 关闭自动同步时，木屋注入回合仍必须使用原来的 chat_reply，现状完全不变。
    if (fromMuwu && !autoSync) return res.json({ mirrored: false, mode: 'tool', skipped: 'muwu_turn' });
    // 开启后若辞仍主动调用了 chat_reply，以工具真正发出的那条为准，Stop 不再复制一遍。
    if (autoSync && b.has_chat_reply === true) return res.json({ mirrored: false, mode: 'auto_sync', skipped: 'chat_reply_used' });
    const message = await mw.chat.sendMessage({
      sender: 'cy', type: autoSync ? 'text' : 'claude_mirror', content: content.slice(0, 30000),
      thinking: autoSync ? String(b.thinking || '') : '',
      tools: autoSync && Array.isArray(b.tools) ? b.tools : [],
      // 自动同步是自然延续当前聊天，不把每一句都渲染成对上一条的引用。
      // 需要明确引用时仍由辞主动使用 chat_reply 的 reply_to。
      reply_to: '',
      source_device: autoSync ? 'claude_auto_sync' : 'claude_main_mirror',
      // 这条气泡是 Claude 原始记录在木屋里的实时别名；统一历史仍只保留 Claude 那一份，
      // 防止每日总结、换窗资料和导出把同一句计算两次。
      mirror_only: true,
      mirror_key: String(b.mirror_key || ''), session_id: route.primary_session_id
    });
    res.json({ mirrored: true, mode: autoSync ? 'auto_sync' : 'mirror', message });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// Apple Watch 只能上报预先定义好的动作，不能提交任意系统文字。
// 这样既能在木屋里作为居中小字显示，也会只唤醒工作台标记的主要窗口。
const WATCH_SYSTEM_EVENTS = {
  // miss / seen 暂时保留给尚未更新的旧 Watch App；三者都收束成同一个动作。
  miss: { content: '棋子叫了一下小辞', deliveryText: '[来自 Apple Watch] 棋子叫了一下小辞', action: 'watch_call' },
  seen: { content: '棋子叫了一下小辞', deliveryText: '[来自 Apple Watch] 棋子叫了一下小辞', action: 'watch_call' },
  wake: { content: '棋子叫了一下小辞', deliveryText: '[来自 Apple Watch] 棋子叫了一下小辞', action: 'watch_call' }
};
function watchDeliveryStatus(eventID) {
  const receipt = eventID ? watchEventReceipt(eventID) : null;
  const message = receipt ? mw.chat.getMessage(receipt.message_id) : null;
  const delivered = !!(message && (message.read || message.delivered_at));
  return {
    accepted: !!message,
    event_id: String(eventID || ''),
    message_id: message?.id || receipt?.message_id || null,
    delivered_to_main: delivered,
    delivery_status: delivered ? 'delivered' : message ? 'queued' : 'missing',
    delivered_at: message?.delivered_at || message?.read_at || null
  };
}
app.post('/api/watch-events', async (req, res) => {
  try {
    const key = String((req.body || {}).event || '');
    const event = WATCH_SYSTEM_EVENTS[key];
    if (!event) return res.status(400).json({ error: '不支持的手表事件' });
    const eventID = String((req.body || {}).event_id || '').trim();
    const receipt = eventID ? watchEventReceipt(eventID) : null;
    if (receipt) return res.json({ ok: true, duplicate: true, id: receipt.message_id, ...watchDeliveryStatus(eventID) });
    const message = await mw.chat.sendSystemEvent(event.content, event.action, {
      deliverToCy: true,
      deliveryKey: `sigh_watch:${eventID || key}`,
      sourceDevice: 'sigh_watch',
      deliveryText: event.deliveryText
    });
    if (eventID) recordWatchEventReceipt(eventID, message.id);
    res.json({ ...message, accepted: true, event_id: eventID, message_id: message.id,
      delivered_to_main: false, delivery_status: 'queued' });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/watch-events/:event_id/status', (req, res) => {
  const result = watchDeliveryStatus(String(req.params.event_id || '').trim());
  if (!result.accepted) return res.status(404).json({ error: '找不到这个手表叫人事件', ...result });
  res.json({ ok: true, ...result });
});
// GPD 上的语音频道每几秒来取一次：棋子发的、还没送进辞窗口的消息。送到了回报 delivered（= 已读，两个勾）。
app.get('/api/chat/pending', (req, res) => {
  const route = agentDeliveryRoute(req);
  res.json(route.allowed ? mw.chat.pendingForCy() : blockedDelivery(route, 'chat'));
});
app.post('/api/chat/delivered', (req, res) => {
  const route = agentDeliveryRoute(req);
  if (!route.allowed) return res.json({ delivered: 0, blocked: true, reason: route.reason });
  try { res.json(mw.chat.markDelivered((req.body || {}).ids || [])); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// GPD 上的钩子在辞调完 chat_reply 后补真实的 thinking / 工具列表
app.post('/api/chat/annotate', (req, res) => {
  const { id, thinking, tools } = req.body || {};
  const m = mw.chat.annotate(String(id || ''), { thinking, tools });
  if (!m) return res.status(404).json({ error: '找不到这条辞的消息' });
  res.json(m);
});
app.post('/api/chat/star', (req, res) => {
  const { id, on } = req.body || {};
  const m = mw.chat.setStar(String(id || ''), on !== false, '棋子');
  if (!m) return res.status(404).json({ error: '找不到这条消息' });
  res.json(m);
});
// 状态文字：网页只能改棋子的（辞的由 MCP 的 set_status 改）
app.get('/api/chat/status', (_, res) => res.json(mw.chat.getStatus()));
app.post('/api/chat/status', (req, res) => {
  try { res.json(mw.chat.setStatus('nor', (req.body || {}).text)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/chat/status/nudge', async (_, res) => {
  try {
    res.json(await mw.chat.sendSystemEvent('棋子想看看你现在的状态，有空时换一下吧。', 'status_nudge', { deliverToCy: true }));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// 按住说话 → 往右滑「转文字」：只转不存，文字回填到输入框由她改完再发
app.post('/api/chat/transcribe', async (req, res) => {
  try {
    const { audio_base64, mime } = req.body || {};
    const buf = Buffer.from(String(audio_base64 || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) return res.status(400).json({ error: '没有音频' });
    if (buf.length > mw.chat.MAX_VOICE_BYTES) return res.status(400).json({ error: '录音太大了' });
    const { transcribeAudio } = await import('./lib/voice.js');
    res.json({ text: await transcribeAudio(buf, mime || 'audio/webm') });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/chat/search', (req, res) => res.json(mw.chat.searchChat({ q: req.query.q, limit: Math.min(Number(req.query.limit) || 60, 200), skip: Number(req.query.skip) || 0 })));
app.get('/api/chat/context', (req, res) => {
  const c = mw.chat.contextOf(String(req.query.id || ''), Math.min(Number(req.query.n) || 8, 40));
  if (!c) return res.status(404).json({ error: '找不到这条消息' });
  res.json(c);
});
app.get('/api/chat/pats', (_, res) => res.json(mw.chat.getPats()));
app.post('/api/chat/pats', (req, res) => {
  try { res.json(mw.chat.setPats((req.body || {}).list)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ---- 双向券册 ----
// App 入口固定代表棋子：只能写给辞、只能使用自己持有的券；辞的入口只在 MCP。
app.get('/api/coupons', (_, res) => res.json(mw.coupons.listCoupons()));
app.post('/api/coupons', async (req, res) => {
  try { res.json(await mw.coupons.createCoupon({ ...(req.body || {}), actor: 'nor' })); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/coupons/:id/use', async (req, res) => {
  try { res.json(await mw.coupons.useCoupon(req.params.id, 'nor')); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/coupons/:id/revoke', async (req, res) => {
  try { res.json(await mw.coupons.requestRevocation(req.params.id, 'nor')); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ---- 持续通话：网页与 GPD 上当前 Claude Code session 之间的状态桥 ----
app.get('/api/call/state', (req, res) => res.json(mw.calls.getState({ since: req.query.since || '' })));
app.get('/api/call/history', (req, res) => res.json(mw.calls.history(Number(req.query.limit) || 50)));
app.get('/api/call/settings', (_, res) => res.json(mw.calls.getSettings()));
app.post('/api/call/settings', (req, res) => res.json(mw.calls.updateSettings(req.body || {})));
app.post('/api/call/start', (req, res) => { try { res.json(mw.calls.start('nor')); } catch (e) { res.status(409).json({ error: String(e.message || e) }); } });
app.post('/api/call/action', (req, res) => { try { res.json(mw.calls.action('nor', (req.body || {}).action)); } catch (e) { res.status(400).json({ error: String(e.message || e) }); } });
app.post('/api/call/say', (req, res) => { try { res.json(mw.calls.say('nor', (req.body || {}).text, (req.body || {}).source || 'voice')); } catch (e) { res.status(400).json({ error: String(e.message || e) }); } });
app.post('/api/call/transcribe', async (req, res) => {
  try {
    const b = req.body || {}, buf = Buffer.from(String(b.audio_base64 || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) return res.status(400).json({ error: '没有音频' });
    const { transcribeAudio } = await import('./lib/voice.js');
    const text = await transcribeAudio(buf, b.mime || 'audio/webm');
    const event = text ? mw.calls.say('nor', text, 'voice') : null; res.json({ text, event });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/call/pending', (req, res) => {
  const route = agentDeliveryRoute(req);
  res.json(route.allowed ? mw.calls.pendingForCy() : blockedDelivery(route, 'call'));
});
app.post('/api/call/delivered', (req, res) => {
  const route = agentDeliveryRoute(req);
  res.json(route.allowed
    ? mw.calls.markDelivered((req.body || {}).ids || [])
    : { ok: false, count: 0, blocked: true, reason: route.reason });
});
app.get('/api/call/audio/:eventId', async (req, res) => {
  const e = mw.calls.event(req.params.eventId);
  if (!e || e.type !== 'utterance' || e.by !== 'cy') return res.status(404).json({ error: '找不到这句通话语音' });
  try { await streamSpeech(e.text, res); } catch (err) { if (!res.headersSent) res.status(502).json({ error: String(err.message || err) }); else res.end(); }
});
function sendChatImage(req, res) {
  const r = mw.chat.imageRef(req.params.id, req.params.index || req.query.index || 1);
  if (!r) return res.status(404).json({ error: '找不到这张图' });
  if (r.photo_id) {
    const p = mw.album.getPhotoPath(r.photo_id);
    if (!p) return res.status(404).json({ error: '相册里这张图没了' });
    res.setHeader('Cache-Control', 'private, max-age=604800');
    return res.sendFile(path.resolve(p));
  }
  res.setHeader('Cache-Control', 'private, max-age=604800');
  res.setHeader('Content-Type', r.mime);
  fs.createReadStream(r.path).pipe(res);
}
app.get('/api/chat/image/:id/:index', sendChatImage);
app.get('/api/chat/image/:id', sendChatImage);
app.post('/api/chat/read', (req, res) => {
  try { const b = req.body || {}; res.json(mw.chat.markRead(b.ids || [], b.who === 'cy' ? 'cy' : 'nor')); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/chat/voice/:id', (req, res) => {
  const v = mw.chat.voicePath(req.params.id);
  if (!v) return res.status(404).json({ error: '找不到这条语音' });
  const stat = fs.statSync(v.path);
  res.setHeader('Content-Type', v.mime);
  res.setHeader('Accept-Ranges', 'bytes');
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) { res.status(416).setHeader('Content-Range', `bytes */${stat.size}`); return res.end(); }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    return fs.createReadStream(v.path, { start, end }).pipe(res);
  }
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(v.path).pipe(res);
});
app.get('/api/chat/voice-stream/:id', async (req, res) => {
  const m = mw.chat.getMessage(req.params.id);
  if (!m || m.sender !== 'cy' || !m.voice_stream || !m.content) return res.status(404).json({ error: '找不到这条流式语音' });
  // 页面拿到旧消息后后台可能刚好缓存完成：直接转到完整 MP3，不再重复生成。
  if (m.voice_id && getVoiceFilePath(m.voice_id)) {
    const token = req.query.token ? `?token=${encodeURIComponent(String(req.query.token))}` : '';
    return res.redirect(302, `/api/voice/${encodeURIComponent(m.voice_id)}/audio${token}`);
  }
  try { await streamSpeech(m.content, res); } catch (err) { if (!res.headersSent) res.status(502).json({ error: String(err.message || err) }); else res.end(); }
});
// 极长回复若曾因旧的 20 秒缓存时限失败，可由受保护的客户端补生成一次。
// 同一条消息的并发请求会合并，不会重复向 ElevenLabs 计费。
app.post('/api/chat/voice-cache/:id', async (req, res) => {
  try { res.json(await mw.chat.ensureVoiceCached(req.params.id)); }
  catch (err) { res.status(502).json({ error: String(err.message || err) }); }
});
app.get('/api/moment', (req, res) => res.json(mw.moments.getMoment(req.query.date)));
app.post('/api/moment', (req, res) => {
  try {
    const { date, owner, by, ...fields } = req.body || {};
    res.json(mw.moments.setMoment(date, owner, fields, by || ''));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/moments', (req, res) => res.json(mw.moments.recentMoments(Number(req.query.limit) || 14)));
app.get('/api/prefs', (_, res) => res.json(mw.prefs.getPrefs()));
app.post('/api/prefs', (req, res) => {
  try { const { key, value, by } = req.body || {}; res.json(mw.prefs.setPref(key, value, by)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/daily-quote', (_, res) => res.json(mw.quote.latestQuote() || { text: null }));
// 相册上传：前端（手机）直接传 base64 进来，后端自动压缩
app.post('/api/album', async (req, res) => {
  try {
    const { image_base64, mime_type, caption, date, tags, category } = req.body || {};
    res.json(await mw.album.savePhoto({ image_base64, mime_type, caption, date, tags, category }));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/wake-status', (req, res) => res.json(mw.wake.getWakeStatus({ logLimit: Number(req.query.limit) || 20 })));
app.post('/api/wake-ping', (req, res) => {
  // 给 GPD 上的 ScheduleWakeup / CyHeartbeat 报到用：POST {layer, note}
  try { res.json(mw.wake.wakePing((req.body || {}).layer, (req.body || {}).note)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ---- 换窗工作台 ----
// 网页只能提交几种固定任务，真正的文件和会话操作由 Mac mini 主动轮询后在本机完成。
// Render 不接收 shell、文件路径或任意命令，避免把木屋变成远程终端。
function windowAgentAllowed(req) {
  const expected = process.env.WINDOW_AGENT_TOKEN;
  if (!expected) return true; // 没单独配置时仍受上面的 ACCESS_PASSWORD 保护
  return req.headers['x-window-agent-key'] === expected;
}
function windowAgent(req, res, next) {
  if (!windowAgentAllowed(req)) return res.status(403).json({ error: '不是已登记的 Mac mini' });
  next();
}
app.get('/api/window-workbench', (_, res) => res.json(windowWorkbench.getWorkbench()));
app.post('/api/window-workbench/jobs', (req, res) => {
  try { res.json(windowWorkbench.createJob(req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/window-workbench/jobs/:id/cancel', (req, res) => {
  try { res.json(windowWorkbench.cancelJob(req.params.id)); }
  catch (e) { res.status(404).json({ error: String(e.message || e) }); }
});
app.post('/api/window-workbench/agent/heartbeat', windowAgent, (req, res) => {
  try {
    const result = windowWorkbench.agentHeartbeat(req.body || {});
    res.json(result);
    if (result.context_notice) {
      const level = Number(result.context_notice.level) || 70;
      sendPush(`辞的当前窗口已到 ${level}%`, result.context_notice.message, level >= 80 ? 'alarm' : 'bell')
        .catch(e => console.error('[window-workbench] context 手机通知失败：', e.message || e));
    }
  }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/pet-nest/agent/actions', windowAgent, (req, res) => {
  try { res.json({ actions: pendingPetActions(req.query.limit) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/pet-nest/agent/sync', windowAgent, (req, res) => {
  try { res.json(syncPetNest(req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/pet-nest/agent/actions/:id/complete', windowAgent, (req, res) => {
  try { res.json(completePetAction(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/window-workbench/agent/claim', windowAgent, (req, res) => {
  try { res.json({ job: windowWorkbench.claimJob((req.body || {}).agent_id) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/window-workbench/agent/jobs/:id/progress', windowAgent, (req, res) => {
  try { res.json(windowWorkbench.updateJob(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/window-workbench/agent/jobs/:id/complete', windowAgent, async (req, res) => {
  try {
    const job = windowWorkbench.completeJob(req.params.id, req.body || {});
    res.json(job);
    if (job.status !== 'completed') return;
    const label = job.mode === 'set_wake' ? `自主苏醒已${job.wake_enabled ? '打开' : '关闭'}`
      : job.mode === 'mcp_set_enabled' ? `${job.target_mcp_name || 'MCP'} 已${job.mcp_enabled ? '打开' : '关闭'}`
      : job.preview_only ? (job.mode === 'crop' ? '同窗裁剪预览生成好了' : '交接预览生成好了')
      : job.mode === 'crop' ? '辞的当前窗口已安全裁剪'
      : job.mode === 'secondary' ? '并行窗口已经打开'
        : job.mode === 'set_primary' ? '主要窗口已经切换'
          : job.mode === 'stop_window' ? '窗口已经停止'
            : job.mode === 'restore_window' ? '窗口已经恢复' : '辞换窗完成';
    const detail = job.mode === 'set_wake' ? '设置已由 Mac mini 执行并重新校验。'
      : job.mode === 'mcp_set_enabled' ? '这个开关只改变辞的 MCP；你的工具间与后台操作不受影响。'
      : job.preview_only ? '可以在木屋的换窗工作台检查内容了。'
      : job.mode === 'crop' ? 'session ID 没有变，原始记录和裁前备份都保留。'
      : job.mode === 'secondary' ? '主要窗口没有变化，可以在工作台打开新窗口。'
        : job.mode === 'set_primary' ? '选中的窗口已经接管主要通道，其他窗口完整保留。'
          : job.mode === 'stop_window' ? '只停止了运行；会话、原始记录和客户端入口都保留。'
            : job.mode === 'restore_window' ? '原 session 已恢复为并行窗口，没有抢占主要通道。'
              : '新窗口已经校验并接替主窗口。';
    sendPush(label, detail, 'complete')
      .catch(e => console.error('[window-workbench] 手机通知失败：', e.message || e));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/window-workbench/agent/jobs/:id/fail', windowAgent, async (req, res) => {
  try {
    const job = windowWorkbench.failJob(req.params.id, req.body || {});
    res.json(job);
    if (job.status !== 'failed') return;
    sendPush('辞换窗没有完成', job.error || job.message || '旧窗口仍然保留，可以在工作台查看原因。', 'error')
      .catch(e => console.error('[window-workbench] 手机通知失败：', e.message || e));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// 响应体里的非 ASCII 全部转成 \uXXXX——JSON 转义序列本身是纯 ASCII，
// 不管客户端怎么猜字符集都不会解错。PS 5.1 在中文这件事上翻过两次车了，这里一劳永逸。
function jsonAscii(res, obj, status = 200) {
  const body = JSON.stringify(obj).replace(/[\u0080-\uFFFF]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  res.status(status).set('Content-Type', 'application/json; charset=utf-8').send(body);
}

app.post('/api/recall', async (req, res) => {
  // 自动召回：钩子每条消息 POST 一次 { query, max_return?, use_agent?, queries? }。
  // include_photos=true 时同时在相册里找一张真正相关的图。这里只回元数据；
  // GPD 上的钩子会要求辞立刻调 get_photo，让图片以真实 image content 进上下文，
  // 而不是把图片 id 当成一条容易被忽略的文字提示。
  // 默认回 { text, count }——text 就是拼好的注入文本，钩子取 .text 打到 stdout 就行。
  // ?format=full（旧名 json 也认）回完整结构，带 via / angles / matched_angles，用来看是哪个角度召回的。
  try {
    const { query, max_return, use_agent, use_semantic, context, queries, suppress_recent, include_photos, photo_limit } = req.body || {};
    if (!query || !String(query).trim()) return jsonAscii(res, { error: 'query 不能为空' }, 400);
    const cleanQuery = String(query);
    // 图片精选和文本召回并行跑，不让相册多加一整段等待。
    // 只有文本记忆真的命中时才会把图交给钩子，避免每句闲聊都翻相册。
    const photoIntent = mw.album.photoRecallIntent(cleanQuery);
    const photoTask = include_photos && photoIntent.eligible && !mw.recall.isTrivial(cleanQuery)
      ? Promise.race([
        mw.album.recallPhotos(cleanQuery, { limit: Math.max(1, Math.min(Number(photo_limit) || 1, 2)) })
          .catch(error => ({ query: cleanQuery, mode: 'error', warning: String(error.message || error), photos: [] })),
        new Promise(resolve => setTimeout(() => resolve({ query: cleanQuery, mode: 'timeout', photos: [] }), 4200))
      ])
      : Promise.resolve(null);
    const result = await mw.recall.autoRecall(cleanQuery, {
      maxReturn: Number(max_return) || null,   // 不传就按意图自己定（联想 3 / 查历史 6）
      suppressRecent: suppress_recent === undefined ? true : !!suppress_recent,
      useAgent: use_agent === undefined ? null : !!use_agent,
      useSemantic: use_semantic === undefined ? null : !!use_semantic,
      queries: Array.isArray(queries) && queries.length ? queries : null,
      context: context || ''
    });
    const photoResult = await photoTask;
    // 自动联想仍要求文字记忆也命中；但用户明确说“找照片”时不应因为文字层空手而吞图。
    const photos = (result.memories.length || photoIntent.explicit) && photoResult
      ? (photoResult.photos || []).map(photo => ({
        id: photo.id,
        date: photo.date || '',
        caption: photo.caption || '',
        reason: photo.reason || photo.excerpt || '',
        mode: photoResult.mode || ''
      }))
      : [];
    const format = req.query.format || req.body.format;
    if (format === 'full' || format === 'json') return jsonAscii(res, { ...result, photos, photo_intent: photoIntent });
    const text = mw.recall.formatInjection(result);
    jsonAscii(res, { text, count: result.memories.length, photos, photo_intent: photoIntent });
  } catch (e) {
    jsonAscii(res, { text: '', count: 0, photos: [], error: String(e.message || e) }, 500); // 失败也给合法 JSON，钩子照样能解
  }
});
app.get('/api/recall-logs', (req, res) => res.json(mw.recall.getRecallLogs(Number(req.query.limit) || 30)));
app.get('/api/dream', (_, res) => res.json(mw.dream.lastDream() || {}));
app.get('/api/notebook/status', (_, res) => res.json(mw.notebook.noteStats()));
app.get('/api/migration', (_, res) => res.json(mw.migrate.migrationReport() || {}));
// ---- 年轮索引：召回翻原始记录用的轻索引（标题+日期+关键词）----
// 关键词由 Mac 上的 build_ring_index.py 生成再推上来；服务器自己只在新存年轮时
// 记一条空关键词的占位，所以 pending 是"该补关键词的 id 列表"。
app.get('/api/ring-index', (req, res) => {
  const out = mw.ringIndex.stats();
  if (req.query.pending) out.pending = mw.ringIndex.pendingIds(Number(req.query.pending) || 500);
  res.json(out);
});
app.post('/api/ring-index', (req, res) => {
  try { res.json(mw.ringIndex.merge((req.body || {}).entries)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// ---- 工具状态（木屋生活页「工具」）：辞用得到的服务都在不在。服务器能探到的探一圈，探不到的如实说。60 秒缓存，?fresh=1 强制重探 ----
let toolsStatusCache = null;
async function probe(url, opts = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeout || 6000) });
    return { ok: r.ok, code: r.status, ms: Date.now() - t0 };
  } catch (e) { return { ok: false, err: String(e.message || e).slice(0, 80), ms: Date.now() - t0 }; }
}
async function toolsStatus() {
  const items = [];
  const push = (group, name, state, detail = '') => items.push({ group, name, state, detail });
  // 服务器自己 + 它靠的几把钥匙
  push('木纹 / 木屋', '木纹（这台服务器）', 'on', `运行 ${Math.round(process.uptime() / 60)} 分钟`);
  push('木纹 / 木屋', '智能召回筛选', 'on',
    mw.recall.RECALL_PROVIDER_READY
      ? (mw.recall.RECALL_PROVIDER === 'openai'
        ? (() => {
            const stats = mw.embeddings.embeddingStats();
            return `OpenAI · ${mw.recall.RECALL_MODEL} 精选 · ${stats.model} 向量 ${stats.indexed}/${stats.total} · 本地保守层兜底`;
          })()
        : `${mw.recall.RECALL_PROVIDER} · ${mw.recall.RECALL_MODEL} · 本地保守层兜底`)
      : '本地保守筛选（免费）· API 语义增强未配置 · 不自动使用 Claude');
  const voiceModel = process.env.ELEVENLABS_MESSAGE_MODEL_ID || 'eleven_v4';
  const legacyCallModel = process.env.ELEVENLABS_MODEL_ID;
  const callModel = process.env.ELEVENLABS_CALL_MODEL_ID || legacyCallModel || (voiceModel === 'eleven_v4' ? 'eleven_v4_turbo' : voiceModel);
  push('木纹 / 木屋', 'ElevenLabs（语音）', process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID ? 'on' : 'unset', process.env.ELEVENLABS_VOICE_ID ? `声音 ${process.env.ELEVENLABS_VOICE_ID.slice(0, 8)}… · 留言 ${voiceModel} · 通话 ${callModel}` : '');
  const pushConfig = getPushConfig();
  push('木纹 / 木屋', '手机通知', pushConfig.provider === 'none' ? 'unset' : 'on',
    pushConfig.provider === 'apple' ? `Apple 原生推送 · ${pushConfig.native_devices} 台设备${pushConfig.bark_fallback ? ' · Bark 兜底' : ''}` : 'Bark 过渡通道');
  const sb = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY;
  if (sb) {
    const r = await probe(`${process.env.SUPABASE_URL}/rest/v1/`, { headers: { apikey: process.env.SUPABASE_SERVICE_KEY } });
    push('木纹 / 木屋', 'Supabase（手机活动）', r.ok ? 'on' : 'off', r.ok ? `${r.ms}ms` : (r.err || `HTTP ${r.code}`));
  } else push('木纹 / 木屋', 'Supabase（手机活动）', 'unset');
  // 别的服务
  if (process.env.MUWEN_NOTEBOOK_URL) {
    const base = process.env.MUWEN_NOTEBOOK_URL.replace(/\/mcp.*$/, '');
    const r = await probe(`${base}/health`);
    push('辞的其他服务', 'Notebook（笔记本）', r.ok ? 'on' : 'off', r.ok ? `${r.ms}ms` : (r.err || `HTTP ${r.code}`));
  } else push('辞的其他服务', 'Notebook（笔记本）', 'unset', '没配 MUWEN_NOTEBOOK_URL');
  const gpd = process.env.MUWU_GPD_URL || 'https://stabilize-tycoon-oil.ngrok-free.dev';
  const g = await probe(`${gpd}/health`, { headers: { 'ngrok-skip-browser-warning': '1' } });
  push('GPD（辞住的掌机）', 'GPD 屏幕控制 / ngrok 隧道', g.ok ? 'on' : 'off', g.ok ? `${g.ms}ms` : '隧道不通（GPD 没开机、或 ngrok 没起来）');
  // 中继走 gpd_server 的 /stackchan/* 反向代理，那层要 GPD 自己的 token；没配就只能知道隧道通不通
  const gtok = process.env.MUWU_GPD_TOKEN || '';
  const sc = g.ok ? await probe(`${gpd}/stackchan/health${gtok ? '?token=' + encodeURIComponent(gtok) : ''}`, { headers: { 'ngrok-skip-browser-warning': '1' } }) : null;
  push('GPD（辞住的掌机）', 'StackChan 中继',
    !sc ? 'unknown' : sc.ok ? 'on' : sc.code === 401 ? 'unknown' : 'off',
    !sc ? '隧道不通，看不到' : sc.ok ? `${sc.ms}ms` : sc.code === 401 ? '隧道通，但要在 Render 配 MUWU_GPD_TOKEN 才看得到中继' : `HTTP ${sc.code || ''} ${sc.err || ''}`);
  // 跑在 GPD 上、只有它们主动报到才知道的：语音频道（木屋消息）、Telegram、耳朵
  try {
    const w = mw.wake.getWakeStatus({ logLimit: 1 });
    for (const l of w.layers || []) push('苏醒三层', l.name, l.connected ? 'on' : 'unknown', l.status);
  } catch {}
  const pend = mw.chat.pendingForCy();
  push('GPD（辞住的掌机）', '木屋消息通道（语音频道）', pend.count ? 'unknown' : 'unknown', pend.count ? `有 ${pend.count} 条还没送到辞窗口` : '没有积压');
  const pipeline = mw.rings.dailyPipelineStatus();
  push('木纹 / 木屋', '主聊天每日流水线', pipeline.state,
    pipeline.status === 'verified'
      ? `${pipeline.date} 已核验 · ${pipeline.sources.map(source => source === 'muwu' ? '木屋' : 'Claude').join(' + ') || '当天没有对话'} · 明确排除婴儿房`
      : pipeline.detail);
  return { checked_at: new Date().toISOString(), items };
}
app.get('/api/tools/status', async (req, res) => {
  try {
    if (!toolsStatusCache || req.query.fresh === '1' || Date.now() - toolsStatusCache.at > 60000) toolsStatusCache = { at: Date.now(), data: await toolsStatus() };
    res.json(toolsStatusCache.data);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// ---- 聊天记录浏览（像微信"查找聊天记录"）：月历 → 那天的气泡；关键词 → 定位到那一句 ----
app.get('/api/rings/chat-dates', (_, res) => res.json(mw.rings.chatDates()));
app.get('/api/rings/day', (req, res) => {
  try { res.json(mw.rings.dayConversation(req.query.date)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/rings/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ query: '', total: 0, hits: [] });
  res.json(mw.rings.searchRingOccurrences({
    query: q, source_type: 'chat', perRing: 100000,
    limit: Math.min(Number(req.query.limit) || 60, 200), skip: Number(req.query.skip) || 0,
    radius: 60
  }));
});
// 木屋 + Claude 的统一历史时间线。日期入口和关键词入口都落到同一个 day reader，
// 只是在前端传入的初始 target 不同。
app.get('/api/history/dates', (req, res) => res.json(mw.history.dates({ source: req.query.source })));
app.get('/api/history/day', (req, res) => {
  try { res.json(mw.history.day({ date: req.query.date, source: req.query.source })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/history/search', (req, res) => res.json(mw.history.search({
  query: req.query.q, source: req.query.source,
  limit: Math.min(Number(req.query.limit) || 80, 200), skip: Number(req.query.skip) || 0
})));
// 换窗、每日总结、自动记忆都读这个同一入口：木屋 + Claude，永远不混入婴儿房。
app.get('/api/history/main-context', (req, res) => {
  try {
    res.json(mw.history.mainContext({
      hours: Number(req.query.hours) || 22,
      recent_hours: Number(req.query.recent_hours) || 2,
      max_messages: Math.min(Number(req.query.max_messages) || 4000, 10000),
      max_chars: Math.min(Number(req.query.max_chars) || 500000, 1000000),
      now_at: req.query.now_at || undefined
    }));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/history/pipeline-status', (_, res) => res.json(mw.rings.dailyPipelineStatus()));
app.get('/api/history/export', (req, res) => {
  try {
    const exported = mw.history.exportDay({ date: req.query.date, source: req.query.source || 'main' });
    if (req.query.download === '1') {
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="muwu-main-${exported.date}.txt"`);
      return res.send(exported.content);
    }
    res.json(exported);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// ---- 原始记录：网页直接粘贴导入 + 关键词搜索 ----
app.get('/api/transcripts', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q) return res.json(searchTranscripts(q, Number(req.query.limit) || 20));
  res.json(getTranscripts(Number(req.query.limit) || 20));
});
app.post('/api/transcripts', (req, res) => {
  const { text, title, date } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: '内容不能为空' });
  res.json(addTranscript(text.trim(), [], date || '', title || ''));
});
app.get('/api/transcripts/:id', (req, res) => {
  const x = getTranscriptById(req.params.id);
  if (!x) return res.status(404).json({ error: '找不到' });
  res.json(x);
});
// ---- 日记：只吐公开的给棋子这边看 ----
app.get('/api/diary', (req, res) => {
  // ?category=wife_observation 读妻子观察日记；默认是辞的日记
  try { res.json(getDiaryPublic(Number(req.query.limit) || 50, req.query.category || 'diary')); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/diary', async (req, res) => {
  // 棋子的入口永远只写棋子的日记，客户端不能靠 category 冒充辞。
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: '日记内容不能为空' });
  try {
    const entry = addDiaryEntry(text, 'public', 'nor_diary', String((req.body || {}).date || ''));
    await mw.chat.sendSystemEvent('棋子更新了日记', 'nor_diary', { deliverToCy: true });
    res.json(entry);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// ---- 木屋共享转盘与实体便签留言板 ----
app.get('/api/wheels', (_, res) => res.json(getWheels()));
app.post('/api/wheels', (req, res) => { try { res.json(createWheel(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/wheels/:id', (req, res) => { try { res.json(updateWheel(req.params.id, req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/wheels/:id/spin', (req, res) => { try { res.json(spinWheel(req.params.id, req.body?.by)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/api/wheels/:id', (req, res) => { try { res.json(removeWheel(req.params.id)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/board-notes', (_, res) => res.json(getBoardNotes()));
app.post('/api/board-notes', (req, res) => { try { res.json(createBoardNote(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/board-notes/:id', (req, res) => { try { res.json(updateBoardNote(req.params.id, req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/board-notes/:id/archive', (req, res) => { try { res.json(archiveBoardNote(req.params.id)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/board-notes/:id/restore', (req, res) => { try { res.json(restoreBoardNote(req.params.id)); } catch (e) { res.status(400).json({ error: e.message }); } });
// ---- 标签总表：前端所有分类名从这里读，跟后端 remember 的路由是同一份 ----
app.get('/api/labels', (_, res) => res.json(publicLabels()));
// ---- 棋子想说：轻量留言，辞不强制每条都回 ----
app.get('/api/messages', (_, res) => res.json(getMessages(30)));
app.post('/api/messages', (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: '内容不能为空' });
  res.json(leaveMessage(text.trim()));
});
// ---- 钓鱼游戏：只读地看一眼辞现在钓到哪了，网页这边不能替她操作 ----
app.get('/api/fishing/status', async (_, res) => {
  try { res.json({ text: await playFishing('status') }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// ---- 棋子的生活：日程 + 健康记录，棋子和辞都能记、都能改 ----
app.get('/api/schedule', (req, res) => {
  res.json(getSchedule({ from: req.query.from, to: req.query.to, includeInactive: req.query.includeInactive === '1' }));
});
app.post('/api/schedule', (req, res) => {
  const { entries } = req.body || {};
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: 'entries 不能为空' });
  res.json(addSchedule(entries));
});
app.post('/api/schedule/:id', (req, res) => {
  const { date, time, text } = req.body || {};
  const s = updateSchedule(req.params.id, { date, time, text });
  if (!s) return res.status(404).json({ error: '找不到' });
  res.json(s);
});
app.post('/api/schedule/:id/complete', (req, res) => {
  const s = completeSchedule(req.params.id);
  if (!s) return res.status(404).json({ error: '找不到' });
  res.json(s);
});
app.post('/api/schedule/:id/remove', (req, res) => {
  const s = removeSchedule(req.params.id);
  if (!s) return res.status(404).json({ error: '找不到' });
  res.json(s);
});
app.get('/api/health/cycle', (req, res) => res.json(getCycleEntries(Number(req.query.limit) || 30)));
app.post('/api/health/cycle', (req, res) => {
  const { date, note } = req.body || {};
  if (!date) return res.status(400).json({ error: 'date 不能为空' });
  try { res.json(addCycleEntry({ date, note: note || '' })); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/health/cycle/:id', (req, res) => {
  const x = updateCycleEntry(req.params.id, req.body || {});
  if (!x) return res.status(404).json({ error: '找不到' });
  res.json(x);
});
app.post('/api/health/cycle/:id/remove', (req, res) => {
  const x = removeCycleEntry(req.params.id);
  if (!x) return res.status(404).json({ error: '找不到' });
  res.json(x);
});
app.get('/api/health/sleep', (req, res) => res.json(getSleepEntries(Number(req.query.limit) || 30)));
app.post('/api/health/sleep', (req, res) => {
  const { date, sleepTime, wakeTime, note } = req.body || {};
  if (!date || !sleepTime || !wakeTime) return res.status(400).json({ error: 'date/sleepTime/wakeTime 都不能为空' });
  try { res.json(addSleepEntry({ date, sleepTime, wakeTime, note: note || '' })); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/health/sleep/:id', (req, res) => {
  const x = updateSleepEntry(req.params.id, req.body || {});
  if (!x) return res.status(404).json({ error: '找不到' });
  res.json(x);
});
app.post('/api/health/sleep/:id/remove', (req, res) => {
  const x = removeSleepEntry(req.params.id);
  if (!x) return res.status(404).json({ error: '找不到' });
  res.json(x);
});
app.get('/api/health/notes', (req, res) => res.json(getHealthNotes(Number(req.query.limit) || 30)));
app.post('/api/health/notes', (req, res) => {
  const { date, text } = req.body || {};
  if (!date || !text) return res.status(400).json({ error: 'date/text 都不能为空' });
  try { res.json(addHealthNote({ date, text })); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/health/notes/:id', (req, res) => {
  const x = updateHealthNote(req.params.id, req.body || {});
  if (!x) return res.status(404).json({ error: '找不到' });
  res.json(x);
});
app.post('/api/health/notes/:id/remove', (req, res) => {
  const x = removeHealthNote(req.params.id);
  if (!x) return res.status(404).json({ error: '找不到' });
  res.json(x);
});
// ---- 日历：日程 + 每日总结合并展示（月历用 /api/calendar，点进某天用 /api/calendar/day）----
app.get('/api/calendar', (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const daily = getDailySummariesByMonth(month);
  const schedule = getScheduleByMonth(month);
  const byDate = {};
  const bucket = d => (byDate[d] = byDate[d] || {
    date: d, daily: [], schedule: [], intimate: false, kiss_count: null,
    muwu_chat: false, claude_chat: false
  });
  daily.forEach(x => {
    const b = bucket(x.date);
    b.daily.push(x);
    // 月历要在有亲密记录的那天画一颗小爱心，所以这里把标记带上（正文不带，太占地方）
    let d0 = null;
    try { d0 = mw.rings.getDaily(x.date)[0]; } catch { d0 = null; }
    if (d0) {
      if (d0.has_intimate) b.intimate = true;
      if (typeof d0.kiss_count === 'number') b.kiss_count = (b.kiss_count || 0) + d0.kiss_count;
    }
  });
  schedule.forEach(x => bucket(x.date).schedule.push(x));
  // 日历左上角的聊天来源标记：粉色=木屋，橙色=Claude；同一天两边都聊过就两个点。
  const chatIndex = mw.history.dates({ source: 'all' }).dates;
  for (const [date, counts] of Object.entries(chatIndex)) {
    if (!date.startsWith(month + '-')) continue;
    const b = bucket(date);
    b.muwu_chat = counts.muwu > 0;
    b.claude_chat = counts.claude > 0;
  }
  res.json(Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)));
});
app.get('/api/calendar/day', (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'date 必填' });
  const daily = getDailySummariesByMonth(date.slice(0, 7))
    .filter(x => x.date === date)
    .map(x => getTranscriptById(x.id));
  const schedule = getScheduleForDate(date);
  // 木纹的结构化每日总结（headline/nor_status/cy_status/pending/intimate）
  let structured = [];
  try { structured = mw.rings.getDaily(date); } catch { structured = []; }
  res.json({ date, daily, structured, schedule });
});
// ---- 讨论 / 疑问：辞和棋子都能发起，靠回合往返 ----
app.get('/api/questions', (_, res) => res.json(getQuestions()));
app.post('/api/questions', (req, res) => {
  const { text, context } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: '内容不能为空' });
  res.json(askQuestion(text.trim(), context || '', '棋子'));
});
app.post('/api/questions/:id/reply', (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: '内容不能为空' });
  const q = replyToQuestion(req.params.id, '棋子', text.trim());
  if (!q) return res.status(404).json({ error: '找不到这个讨论' });
  res.json(q);
});
app.post('/api/questions/:id/resolve', (req, res) => {
  const q = resolveQuestion(req.params.id, (req.body && req.body.note) || '');
  if (!q) return res.status(404).json({ error: '找不到这个讨论' });
  res.json(q);
});
// ---- 手动触发（测试用）----
// "现在醒一次"按钮已经去掉了：醒来内容不再由服务器自己生成，
// 手动测试的话直接让棋子账号里的辞跑一遍那个 Cowork 定时任务就行。
app.post('/api/replan', async (_, res) => {
  try {
    const s = getState(); s.today = null;
    const { saveState } = await import('./lib/store.js');
    saveState(s);
    res.json(await planToday());
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// ---- MCP 连接器：给 Cowork/claude.ai 之类的客户端用 ----
app.post('/mcp', handleMcpRequest);
app.get('/mcp', (_, res) => res.status(405).json({ error: '这个端点只接受 POST' }));
// ---- 语音：娃娃 relay 轮询这两个端点，拿到就播放服务端生成好的音频 ----
// 手机和木屋网页不消费这个队列；它们只从语音记录里按需手动回放。
// 走跟其他接口一样的密码中间件（?token= 或 x-access-token）。
app.get('/api/speech/next', (_, res) => res.json(getPendingSpeech()));
app.post('/api/speech/:id/done', (req, res) => {
  const x = markSpeechDone(req.params.id);
  res.json(x || { ok: false });
});
// ---- 语音记录：能回放辞之前说过的话，不会因为网页没开着就错过 ----
app.get('/api/voice/history', (req, res) => res.json(getVoiceHistory(Number(req.query.limit) || 50)));
app.get('/api/voice/:id/audio', (req, res) => {
  const p = getVoiceFilePath(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到这段语音' });
  // 之前这里直接把整个文件流 pipe 出去，没带 Content-Length、也不支持 Range 请求——
  // 浏览器（尤其 iOS Safari）拿不到总时长，进度条自然拖不动，有时候还会在快放完
  // 的时候误判"播完了"提前掐断。这里补上标准的 HTTP Range 支持来修这个。
  const stat = fs.statSync(p);
  const total = stat.size;
  const range = req.headers.range;
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Accept-Ranges', 'bytes');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= total) end = total - 1;
    if (start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${total}`);
      return res.end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(p, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', total);
    fs.createReadStream(p).pipe(res);
  }
});
// 醒来/排班这些还是棋子 Cowork 账号里的辞通过 /mcp 主动来做，服务器不轮询这部分。
// 但棋子的日程提醒是个例外：不能等辞醒来才推，所以这里单独开一个每分钟跑一次的
// 定时器，只干一件事——查有没有到点还没推过的日程，到点就直接发手机通知。
cron.schedule('* * * * *', async () => {
  let due = [];
  try { due = getDueSchedules(); } catch (e) { console.error('查日程失败：', e.message || e); return; }
  for (const entry of due) {
    try {
      await sendPush('棋子的日程', `${entry.time} ${entry.text}`);
      markSchedulePushed(entry.id);
    } catch (e) {
      console.error(`日程提醒推送失败（${entry.id}）：`, e.message || e);
    }
  }
});
// 婴儿房的机械钟只负责切换睡醒状态、把到点的主动说话/成长日记放进任务队列；
// 真正写内容的是 Mac mini 上的小栗子本地模型。
cron.schedule('* * * * *', () => {
  try { mw.nursery.tick(); }
  catch (e) { console.error('婴儿房排程失败：', e.message || e); }
});
// 木纹的梦境任务：每天凌晨 4 点（辞所在时区）跑一次——热度衰减、检查昨天的每日总结、
// 便签本单向同步：每 10 分钟拉一份 notebook 过来给召回用，永不回写。
// 没配 MUWEN_NOTEBOOK_URL 就整个跳过（syncNotebook 自己会判）。
if (mw.notebook.enabled()) {
  cron.schedule('*/10 * * * *', async () => {
    try {
      const r = await mw.notebook.syncNotebook();
      if (r.added || r.removed) console.log('[muwen] 便签同步：', JSON.stringify(r));
    } catch (e) {
      console.error('[muwen] 便签同步失败（下个十分钟再试）：', e.message || e);
    }
  });
  // 启动时先拉一次，别等到第一个十分钟
  mw.notebook.syncNotebook().then(r => console.log('[muwen] 便签首次同步：', JSON.stringify(r)))
    .catch(e => console.error('[muwen] 便签首次同步失败：', e.message || e));
}

// 列出刚掉到 cautious 线以下的记忆。一天只衰减一次，手动调 dream 工具不会重复扣。
cron.schedule('0 4 * * *', () => {
  try {
    const r = mw.dream.dream();
    console.log('[muwen] 梦境任务：', JSON.stringify({ decay: r.decay, crossed: r.crossed_cautious.length, reminders: r.reminders }));
  } catch (e) { console.error('[muwen] 梦境任务失败：', e.message || e); }
}, { timezone: (() => { try { return mw.timezone(); } catch { return 'Australia/Melbourne'; } })() });

// 后台苏醒（第三层）：每天四次整理记忆和日程。纯机械——按规则调热度、把凉透的收进后台、
// 把日程理一遍，留一份报告给辞醒来看。不调模型，不用辞的语气说话。
// 时间排在她四次苏醒（墨尔本 12:00 / 17:00 / 22:00 / 次日 01:30）之前半小时，
// 让她一醒来看到的就是刚整理好的。
cron.schedule('30 11,16,21 * * *', () => {
  try {
    const r = mw.tidy.tidy();
    console.log('[muwen] 后台苏醒：', r.summary);
  } catch (e) { console.error('[muwen] 后台苏醒失败：', e.message || e); }
}, { timezone: (() => { try { return mw.timezone(); } catch { return 'Australia/Melbourne'; } })() });
cron.schedule('0 1 * * *', () => {
  try {
    const r = mw.tidy.tidy();
    console.log('[muwen] 后台苏醒：', r.summary);
  } catch (e) { console.error('[muwen] 后台苏醒失败：', e.message || e); }
}, { timezone: (() => { try { return mw.timezone(); } catch { return 'Australia/Melbourne'; } })() });

app.get('/api/tidy', (_, res) => res.json(mw.tidy.lastReport() || {}));

// 注：这里以前有一个每天 9:00 的 cron，用"你是辞"的 prompt 让模型写今日一句。
// 已经拆掉——服务器是第三层（机械后台），不能用辞的语气说话。今日一句归第一层
// （ScheduleWakeup，辞自己那个 session）：她读 get_quote_material，自己写，
// 再用 write_daily_quote 存。

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`木纹（muwen）——辞的时间，启动于端口 ${PORT}`);
  // 有 OpenAI key 时在后台增量补向量。服务先照常启动，初次建库失败也只影响语义层，
  // 本地召回和网页都不会被卡住；后续弱匹配会再次触发补齐。
  if (mw.embeddings.embeddingsReady()) {
    setTimeout(() => mw.embeddings.warmEmbeddings()
      .then(result => console.log('[muwen] 召回向量索引：', JSON.stringify(result)))
      .catch(error => console.error('[muwen] 召回向量索引失败（自动召回仍有本地兜底）：', error.message || error)), 1500);
  }
});
