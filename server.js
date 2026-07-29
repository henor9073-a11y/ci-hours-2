import express from 'express';
import multer from 'multer';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  getState, updateSettings, getShelf, removeBook,
  getNotes, getLog, getBookContent
} from './lib/store.js';
import { searchGutenberg, addFromGutenberg, addFromUpload } from './lib/books.js';
import { wakeUp, tick, planToday } from './lib/ci.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

// ---- 简单的密码保护 ----
const PASSWORD = process.env.ACCESS_PASSWORD;
app.use((req, res, next) => {
  if (!PASSWORD) return next();
  if (req.path === '/health' || req.path === '/login.html') return next();
  const token = req.headers['x-access-token'] || req.query.token;
  if (token === PASSWORD) return next();
  if (req.path === '/' || req.path.endsWith('.html') || req.path.endsWith('.css')) return next();
  return res.status(401).json({ error: '需要密码' });
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

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
  res.json({ id: c.id, title: c.title, chapters: c.chapters.map(ch => ch.title) });
});

// ---- 记录与日志 ----
app.get('/api/notes', (_, res) => res.json(getNotes(200)));
app.get('/api/log', (_, res) => res.json(getLog(200)));

// ---- 手动触发（测试用）----
app.post('/api/wake-now', async (_, res) => {
  try { res.json(await wakeUp('manual')); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/replan', async (_, res) => {
  try {
    const s = getState(); s.today = null;
    const { saveState } = await import('./lib/store.js');
    saveState(s);
    res.json(await planToday());
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- 定时器：每分钟检查一次 ----
cron.schedule('* * * * *', () => {
  tick().catch(e => console.error('tick 出错', e));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`辞的时间，启动于端口 ${PORT}`));
