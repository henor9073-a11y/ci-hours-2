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
import {
  getMemory, getQuestions, askQuestion, replyToQuestion, resolveQuestion
} from './lib/memory.js';
import { handleMcpRequest } from './lib/mcp.js';
import { mountOAuth } from './lib/oauth-routes.js';
import { checkToken as checkOAuthToken } from './lib/oauth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true); // Render 在代理后面，这样 req.protocol 才能正确识别 https
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

// ---- 跨域许可：给浏览器里直接发请求的场景用（比如调试面板、未来的网页小工具）----
// 放在密码校验前面，让 OPTIONS 预检请求不会被密码卡住。
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-access-token');
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

// ---- 记忆 ----
app.get('/api/memory', (_, res) => res.json(getMemory()));

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

// ---- MCP 连接器：给 Cowork/claude.ai 之类的客户端用 ----
app.post('/mcp', handleMcpRequest);
app.get('/mcp', (_, res) => res.status(405).json({ error: '这个端点只接受 POST' }));

// ---- 定时器：每分钟检查一次 ----
cron.schedule('* * * * *', () => {
  tick().catch(e => console.error('tick 出错', e));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`辞的时间，启动于端口 ${PORT}`));
