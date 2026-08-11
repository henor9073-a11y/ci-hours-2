import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import {
  getState, updateSettings, getShelf, removeBook,
  getNotes, getLog, getBookContent
} from './lib/store.js';
import { searchGutenberg, addFromGutenberg, addFromUpload } from './lib/books.js';
import { planToday } from './lib/ci.js';
import {
  getMemory, getQuestions, askQuestion, replyToQuestion, resolveQuestion
} from './lib/memory.js';
import { handleMcpRequest } from './lib/mcp.js';
import { mountOAuth } from './lib/oauth-routes.js';
import { checkToken as checkOAuthToken } from './lib/oauth.js';
import { getPendingSpeech, markSpeechDone } from './lib/speech.js';
import { getVoiceHistory, getVoiceFilePath } from './lib/voice.js';
import { addTranscript, getTranscripts, searchTranscripts, getTranscriptById, getDailySummariesByMonth } from './lib/transcripts.js';
import { getDiaryPublic } from './lib/diary.js';
import { leaveMessage, getMessages } from './lib/messages.js';
import { playFishing } from './lib/fishing.js';
import { sendPush } from './lib/bark.js';
import {
  addSchedule, getSchedule, updateSchedule, completeSchedule, removeSchedule, getDueSchedules, markSchedulePushed,
  getScheduleByMonth, getScheduleForDate
} from './lib/schedule.js';
import {
  addCycleEntry, getCycleEntries, updateCycleEntry, removeCycleEntry,
  addSleepEntry, getSleepEntries, updateSleepEntry, removeSleepEntry,
  addHealthNote, getHealthNotes, updateHealthNote, removeHealthNote
} from './lib/health.js';
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
app.get('/api/diary', (_, res) => res.json(getDiaryPublic(50)));
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
  const bucket = d => (byDate[d] = byDate[d] || { date: d, daily: [], schedule: [] });
  daily.forEach(x => bucket(x.date).daily.push(x));
  schedule.forEach(x => bucket(x.date).schedule.push(x));
  res.json(Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)));
});
app.get('/api/calendar/day', (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'date 必填' });
  const daily = getDailySummariesByMonth(date.slice(0, 7))
    .filter(x => x.date === date)
    .map(x => getTranscriptById(x.id));
  const schedule = getScheduleForDate(date);
  res.json({ date, daily, schedule });
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
// ---- 语音：网页轮询这两个端点，拿到就播放服务端生成好的音频 ----
// /mcp 里的 speak 工具把文字（和生成好的音频 id）存进队列，这里给网页拉取/回报消费状态。
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
// 定时器，只干一件事——查有没有到点还没推过的日程，到点就直接 Bark 推给棋子。
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`辞的时间，启动于端口 ${PORT}`));
