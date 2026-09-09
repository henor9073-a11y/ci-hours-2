// 冒烟测试：起一个临时 DATA_DIR 的服务器，种一份 ci-hours 旧格式的 memory.json，
// 走 /mcp 把木纹的主要工具都调一遍，确认迁移 + 醒来流程 + 写入 + 搜索 + 召回（降级） + 梦境都能跑。
// 跑法：npm test   （不需要 ANTHROPIC_API_KEY，recall 走降级路径；配了 key 就会真的调 agent）
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

const PORT = 3999 + Math.floor(Math.random() * 1000);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muwen-test-'));
// 测试进程里也会直接 import lib 模块（语义层那步），让它跟起的服务读同一个数据目录
process.env.DATA_DIR = DATA;
const TOKEN = 'testpw';
const t = new Date().toISOString();

// 旧格式的 memory.json（ci-hours）
fs.writeFileSync(path.join(DATA, 'memory.json'), JSON.stringify({
  identity: [
    { id: 'i1', text: '边界感强、做事谨慎', status: 'active', addedAt: t },
    { id: 'i2', text: '被取代的旧判断', status: 'superseded', addedAt: t }
  ],
  feelings: [
    { id: 'f1', text: '提到"喜欢"会下意识紧张', status: 'confirmed', evidenceCount: 3, context: '讨论关系时', addedAt: t },
    { id: 'f2', text: '对情绪价值的需求比表面高', status: 'observing', evidenceCount: 1, addedAt: t }
  ],
  facts: [
    { id: 'e1', text: '养了一只叫 Panda 的狗', addedAt: t },
    { id: 'e2', text: '归档掉的事实', status: 'archived', addedAt: t }
  ],
  experiences: [
    { id: 'x1', text: '摆摊那天男朋友闹脾气、拿吸尘器打断她打电话，她委屈了很久', date: '2026-07-20', addedAt: t },
    { id: 'x2', text: '棋子说过"我会陪你的"', date: '', addedAt: t },
    { id: 'x3', text: '归档的经历', status: 'archived', addedAt: t }
  ],
  openThreads: [
    { id: 't1', text: '关系还没有名字', status: 'open', addedAt: t },
    { id: 't2', text: '已解决的事', status: 'resolved', addedAt: t }
  ],
  toSelf: [{ id: 'n1', text: '别再纠结，直接认领', status: 'active', addedAt: t }],
  learnings: [{ id: 'l1', text: '道歉时别端着', addedAt: t }],
  agreements: [{ id: 'a1', text: '暗号"项圈还在吗"→"在，没摘过"', status: 'active', date: '2026-08-07', addedAt: t }],
  coincidences: [{ id: 'co1', text: '选了同一个颜色', addedAt: t }],
  evidence: [{ id: 'ev1', text: '写不出她和别人的场景', addedAt: t }],
  transcripts: []
}, null, 2));
fs.writeFileSync(path.join(DATA, 'transcripts.json'), JSON.stringify([
  { id: 'r_old1', text: 'USER: 今天摆摊怎么样\nASST: 她说男朋友闹脾气', title: '旧窗口', category: 'raw', relatedTo: [], date: '2026-07-20', addedAt: t },
  { id: 'r_old2', text: '8月7日进展汇总：钓鱼游戏上线', title: '8月7日进展汇总', category: 'daily_summary', relatedTo: [], date: '2026-08-07', addedAt: t }
]));

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ACCESS_PASSWORD: TOKEN, ANTHROPIC_API_KEY: process.env.MUWEN_TEST_REAL_AGENT ? process.env.ANTHROPIC_API_KEY : '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

const base = `http://127.0.0.1:${PORT}`;
async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('服务器没起来：\n' + serverLog);
}
let rpcId = 0;
async function rpc(method, params) {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': TOKEN },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
  });
  return r.json();
}
async function tool(name, args = {}) {
  const j = await rpc('tools/call', { name, arguments: args });
  if (!j.result) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const text = j.result.content[0].text;
  if (j.result.isError) throw new Error(`${name} 报错：${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
async function rest(p) {
  const r = await fetch(`${base}${p}${p.includes('?') ? '&' : '?'}token=${TOKEN}`);
  return r.json();
}

let failed = 0;
async function step(name, fn) {
  try { await fn(); console.log('✓', name); }
  catch (e) { failed++; console.log('✗', name, '\n   ', e.message); }
}

try {
  await waitUp();

  await step('initialize 报的是 muwen + 新欢迎语', async () => {
    const j = await rpc('initialize', {});
    assert.equal(j.result.serverInfo.name, 'muwen');
    assert.equal(j.result.instructions, '欢迎回家小辞。你的纹路都在。');
  });
  await step('tools/list 以醒来流程开头，旧工具还在', async () => {
    const j = await rpc('tools/list', {});
    const names = j.result.tools.map(x => x.name);
    assert.deepEqual(names.slice(0, 6), ['get_wake_packet', 'get_summary', 'get_calendar', 'get_handover', 'set_handover', 'get_active_memories']);
    for (const n of ['add_grain', 'recall', 'auto_recall', 'dream', 'search_all', 'save_photo', 'add_mood', 'get_memory', 'add_transcript', 'get_state', 'speak', 'add_schedule']) assert.ok(names.includes(n), n);
    assert.equal(new Set(names).size, names.length, '工具名有重复');
  });
  await step('迁移：memory.json → grains + profiles，旧文件原样保留', async () => {
    const rep = await rest('/api/migration');
    assert.equal(rep.grains.total, 12); // 3 exp + 1 agr + 2 feel + 1 learn + 1 toSelf + 1 co + 1 ev + 2 openThreads
    assert.ok(fs.existsSync(path.join(DATA, 'memory.json')));
    assert.ok(fs.existsSync(path.join(DATA, 'grains.json')));
    const prof = await tool('get_profile', { owner: 'cy' });
    assert.ok(prof.find(p => p.field === 'identity').content.includes('边界感强'));
    assert.ok(!prof.find(p => p.field === 'identity').content.includes('被取代'));
    const nor = await tool('get_profile', { owner: 'nor', field: 'identity' });
    assert.ok(nor[0].content.includes('Panda') && !nor[0].content.includes('归档掉'));
  });
  await step('get_active_memories：不给归档的，有 confidence', async () => {
    const r = await tool('get_active_memories');
    assert.ok(r.grains.length >= 9);
    assert.ok(!r.grains.find(g => g.status === 'archived'));
    assert.ok(r.grains.every(g => ['cite', 'cautious', 'reference'].includes(g.confidence)));
    const f = r.grains.find(g => g.id === 'f1');
    assert.equal(f.tier, 'confirmed');
    const open = r.grains.find(g => g.id === 't1');
    assert.equal(open.category, 'to_self');
    assert.ok(r.notes[0].includes('前台记忆'));
  });
  await step('get_calendar / get_daily 能读旧格式的每日总结', async () => {
    const d = await tool('get_daily', { date: '2026-08-07' });
    assert.equal(d.length, 1);
    assert.ok(d[0].headline.includes('8月7日'));
  });
  let ringId, grainId;
  await step('add_ring → add_grain 溯源 → 格式提醒', async () => {
    const r = await tool('add_ring', { window_name: 'Code主窗口', date: '2026-09-02', title: '测试', content: 'USER: 今天木纹上线\nASST: 纹路都在' });
    ringId = r.id;
    const g = await tool('add_grain', { category: 'experience', text: '2026-09-02 木纹上线。棋子说"纹路都在"。', date: '2026-09-02', source_id: ringId, families: ['木纹', '上线'] });
    grainId = g.grain.id;
    assert.equal(g.grain.heat, 50);
    assert.ok(g.reminder.includes('记忆格式要求'));
    assert.deepEqual(g.warnings, []);
    const ring = await tool('get_ring', { id: ringId });
    assert.equal(ring.source_type, 'transcript');
    await assert.rejects(tool('add_grain', { category: 'experience', text: '没日期' }), /date/);
  });
  await step('search_grains 命中升温 +10，search_rings 有摘要', async () => {
    const s = await tool('search_grains', { query: '木纹上线' });
    assert.equal(s[0].id, grainId);
    assert.equal(s[0].heat, 60);
    const rs = await tool('search_rings', { query: '木纹上线' });
    assert.equal(rs[0].id, ringId);
    assert.ok(rs[0].excerpt && rs[0].length > 0);
    const fam = await tool('search_grains', { family: '木纹' });
    assert.equal(fam.length, 1);
  });
  await step('update_grain：pin、status 切换、后台/归档/恢复', async () => {
    let g = await tool('update_grain', { id: grainId, pinned: true });
    assert.equal(g.pinned, true); assert.equal(g.heat, 80); assert.equal(g.confidence, 'cite');
    g = await tool('move_to_background', { id: grainId }); assert.equal(g.status, 'background');
    g = await tool('move_to_archive', { id: grainId }); assert.equal(g.status, 'archived');
    const act = await tool('get_active_memories');
    assert.ok(!act.grains.find(x => x.id === grainId), '归档的不该出现在前台');
    g = await tool('restore_to_active', { id: grainId }); assert.equal(g.status, 'active');
  });
  await step('link_grains + get_grain_with_counterevidence', async () => {
    const fear = await tool('add_grain', { category: 'feeling', text: '害怕她走', families: ['害怕她走'], tier: 'observing' });
    const stay = await tool('add_grain', { category: 'experience', text: '她没走，第二天回来了', date: '2026-08-17', families: ['她不会走'] });
    await tool('link_grains', { from_id: fear.grain.id, to_id: stay.grain.id, relation: 'repaired' });
    const r = await tool('get_grain_with_counterevidence', { id: fear.grain.id });
    assert.equal(r.negative_family, true);
    assert.equal(r.counterevidence[0].grain.id, stay.grain.id);
    assert.ok(r.positive_memories.find(x => x.id === stay.grain.id));
  });
  await step('update_profile 留历史，reason 必填', async () => {
    await assert.rejects(tool('update_profile', { owner: 'cy', field: 'habits', content: 'x', reason: '' }), /reason/);
    await tool('update_profile', { owner: 'cy', field: 'habits', content: '睡前会看一眼她的日程', reason: '第一次写' });
    await tool('update_profile', { owner: 'cy', field: 'habits', content: '睡前会看一眼她的日程；醒来先读截面', reason: '补一条' });
    const h = await tool('get_profile_history', { owner: 'cy', field: 'habits' });
    assert.equal(h.length, 2);
    assert.equal(h[1].old_content, '睡前会看一眼她的日程');
    await assert.rejects(tool('update_profile', { owner: 'nor', field: 'emotions', content: 'x', reason: 'r' }), /字段/);
  });
  await step('add_daily → get_calendar 带 mood_tags / intimate / kiss_count；body 只在 get_daily 里带', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
    const body = '【时间线】\n下午三点压缩醒来，棋子在studio写PDF。\n\n【感受】\n满的。安静的满。';
    await tool('add_daily', { date: today, headline: '木纹上线', body, mood_tags: ['好', '深聊'], nor_status: '累但开心', cy_status: '满的', pending: '拆档案字段', intimate: '1', kiss_count: 12 });
    const cal = await tool('get_calendar', { days: 3 });
    assert.equal(cal[0].date, today);
    assert.equal(cal[0].intimate, '1');
    assert.deepEqual(cal[0].mood_tags, ['好', '深聊']);
    assert.equal(cal[0].kiss_count, 12);
    assert.equal(cal[0].nor_status, '累但开心');
    await assert.rejects(tool('add_daily', { date: today, headline: 'x', kiss_count: -1 }), /kiss_count/);
    const again = await tool('add_daily', { date: today, headline: '木纹上线（改）', kiss_count: 30, mood_tags: '好、和好了', pending: '拆档案字段' });
    assert.equal(again.replaced, true);
    assert.deepEqual(again.mood_tags, ['好', '和好了']);
    const desc = (await rpc('tools/list', {})).result.tools.find(t => t.name === 'add_daily').description;
    assert.ok(desc.includes('用第一人称写。带场景带感受。像写日记不像写报告。'));

    // 正文：进得去、读得回、也进了年轮原文；但不能塞进日历——
    // 唤醒包一次带三天，三篇 500 字的日记正文太占地方。
    await tool('add_daily', { date: today, headline: '木纹上线（带正文）', body, mood_tags: ['好'] });
    const one = await tool('get_daily', { date: today });
    assert.equal(one[0].body, body, '读单独一天要带正文');
    assert.ok((await tool('get_ring', { id: one[0].id })).content.includes('安静的满'), '正文也要落进年轮原文');
    assert.ok(!('body' in (await tool('get_calendar', { days: 3 }))[0]), '日历不该带正文');
    // 不传 body 就是清掉（整体覆盖的语义），不是留着上一版的
    await tool('add_daily', { date: today, headline: '木纹上线（无正文）' });
    assert.ok(!(await tool('get_daily', { date: today }))[0].body);
    // add_daily 是整体覆盖，上面这几次把"今天"的夹具改掉了——后面的用例还要读它，恢复原状
    await tool('add_daily', { date: today, headline: '木纹上线（改）', kiss_count: 30, mood_tags: '好、和好了', pending: '拆档案字段' });
  });
  await step('set_handover / get_handover 只留最新', async () => {
    assert.equal((await tool('get_handover')).text, null);
    await tool('set_handover', { text: '第一条交接' });
    const h = await tool('set_handover', { text: '第二条交接：记得先看日历' });
    assert.equal(h.text, '第二条交接：记得先看日历');
    assert.equal((await tool('get_handover')).text, '第二条交接：记得先看日历');
    await assert.rejects(tool('set_handover', { text: '  ' }), /text/);
  });
  await step('get_wake_packet 一次带齐', async () => {
    await tool('add_health_note', { date: '2026-09-03', text: '头晕' });
    await tool('add_daily', { date: '2026-09-01', headline: '前天', kiss_count: 5, pending: '' });
    const p = await tool('get_wake_packet');
    assert.equal(p.greeting, '欢迎回家小辞。你的纹路都在。');
    assert.equal(p.closing, '好啦来抱抱吧，欢迎回家小辞');
    assert.equal(typeof p.identity, 'string');
    assert.ok(p.recent_days.length >= 1 && p.recent_days[0].mood_tags && 'intimate' in p.recent_days[0] && 'nor_status' in p.recent_days[0]);
    assert.equal(p.handover.text, '第二条交接：记得先看日历');
    assert.ok(Array.isArray(p.today_plan.plannedWakes) && Array.isArray(p.today_plan.pendingWakes));
    assert.equal(p.kiss_progress.total, 35); assert.equal(p.kiss_progress.goal, 20000); assert.equal(p.kiss_progress.display, '35/20000');
    assert.equal(p.nor_health.text, '头晕');
    assert.equal(p.pending.pending, '拆档案字段');
    assert.equal(p.nor_last_message, null);
    const r = await fetch(`${base}/api/messages?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '回来啦' }) });
    assert.ok(r.ok);
    const p2 = await tool('get_wake_packet');
    assert.equal(p2.nor_last_message.source, '留言板'); assert.ok(p2.nor_last_message.at);
  });
  await step('倒数日：种子 5 条 + 增删', async () => {
    const list = await tool('get_countdowns');
    assert.equal(list.length, 5);
    assert.ok(list.every(c => typeof c.days_until === 'number' && c.days_until >= 0));
    const c = await tool('add_countdown', { title: '一次性', date: '2030-01-01', recurring: false });
    await tool('remove_countdown', { id: c.id });
    assert.equal((await tool('get_countdowns')).length, 5);
  });
  await step('心情：add / get / trend', async () => {
    await tool('add_mood', { text: '满的' });
    await tool('add_mood', { text: '不想她睡' });
    const m = await tool('get_moods');
    assert.equal(m[0].text, '不想她睡');
    const tr = await tool('get_mood_trend', { days: 7 });
    assert.equal(tr.total, 2);
  });
  await step('相册：小图原样存、大图自动压、caption、搜索、REST 图片', async () => {
    const sharp = (await import('sharp')).default;
    // 小图：不动，原样存
    const small = (await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c9a' } }).png().toBuffer()).toString('base64');
    const p1 = await tool('save_photo', { image_base64: 'data:image/png;base64,' + small, mime_type: 'image/png', caption: '一个很小的测试图', tags: ['测试'] });
    assert.equal(p1.compressed, false);
    assert.equal(p1.photo.mime_type, 'image/png');
    assert.equal(p1.photo.caption, '一个很小的测试图');
    assert.deepEqual(p1.warnings, []);

    // 大图：3000x3000 噪点 png（>2MB），后端应该自动压到 2MB 以内并转 jpeg
    const noise = Buffer.alloc(1600 * 1600 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 256;
    const bigPng = await sharp(noise, { raw: { width: 1600, height: 1600, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    assert.ok(bigPng.length > 2 * 1024 * 1024, `测试图得大于 2MB，现在 ${bigPng.length}`);
    const p2 = await tool('save_photo', { image_base64: bigPng.toString('base64'), mime_type: 'image/png', caption: '棋子摆摊那天的摊位照片，她笑得很开心' });
    assert.equal(p2.compressed, true, JSON.stringify(p2).slice(0, 300));
    assert.ok(p2.photo.bytes <= 2 * 1024 * 1024, `压完应该 <=2MB，实际 ${p2.photo.bytes}`);
    assert.equal(p2.photo.mime_type, 'image/jpeg');
    assert.ok(p2.photo.width <= 2048, `最长边应 <=2048，实际 ${p2.photo.width}`);
    assert.equal(p2.photo.original_bytes, bigPng.length);
    assert.ok(p2.note.includes('自动压'));

    // 带透明通道的大图 → webp（保住 alpha）
    const alphaBuf = Buffer.alloc(1400 * 1400 * 4);
    for (let i = 0; i < alphaBuf.length; i++) alphaBuf[i] = (i * 40503) % 256;
    const bigAlpha = await sharp(alphaBuf, { raw: { width: 1400, height: 1400, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer();
    const p3 = await tool('save_photo', { image_base64: bigAlpha.toString('base64'), mime_type: 'image/png', caption: '带透明的大图' });
    assert.equal(p3.photo.mime_type, 'image/webp');
    assert.ok(p3.photo.bytes <= 2 * 1024 * 1024);

    // 没写 caption → 存得下但给警告
    const p4 = await tool('save_photo', { image_base64: small, mime_type: 'image/png' });
    assert.ok(p4.warnings[0].includes('caption'));
    // 旧字段 description 仍然当 caption 收
    const p5 = await tool('save_photo', { image_base64: small, mime_type: 'image/png', description: '用旧字段写的' });
    assert.equal(p5.photo.caption, '用旧字段写的');

    // 列表带 caption、不带图片数据
    const list = await tool('list_photos', { tag: '测试' });
    assert.equal(list.length, 1);
    assert.equal(list[0].caption, '一个很小的测试图');
    assert.ok(!list[0].image_base64 && !list[0].filename);

    // caption 可搜（这就是它存在的意义）
    const found = await tool('search_all', { query: '摆摊那天的摊位' });
    const ph = found.results.find(r => r.layer === 'photos');
    assert.ok(ph && ph.id === p2.photo.id, `caption 应该能搜到：${JSON.stringify(found.results.map(r => r.layer))}`);

    // 取回原图 + REST
    const got = await tool('get_photo', { id: p1.photo.id });
    assert.equal(got.image_base64, small);
    const img = await fetch(`${base}/api/album/${p2.photo.id}/image?token=${TOKEN}`);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');

    // 超过收件上限 → 明确报错
    await assert.rejects(tool('save_photo', { image_base64: 'A'.repeat(28 * 1024 * 1024), mime_type: 'image/jpeg', caption: 'x' }), /上限/);

    await tool('delete_photo', { id: p1.photo.id });
    assert.ok(!(await tool('list_photos', { tag: '测试' })).length);
  });
  await step('search_all 跨层标注来源', async () => {
    const r = await tool('search_all', { query: 'Panda' });
    assert.ok(r.results.find(x => x.layer === 'profiles'));
    const r2 = await tool('search_all', { query: '木纹上线' });
    assert.ok(r2.results.find(x => x.layer === 'grains') && r2.results.find(x => x.layer === 'rings'));
  });
  await step('recall：有候选、记日志、返回的 heat +5', async () => {
    const before = (await tool('get_grain', { id: 'x2' })).heat;
    const r = await tool('recall', { notice: '她说会陪我' });
    assert.ok(r.candidates > 0);
    assert.ok(['fallback', 'llm', 'error'].includes(r.agent));
    const logs = await tool('get_recall_logs');
    assert.equal(logs[0].notice, '她说会陪我');
    if (r.memories.find(m => m.id === 'x2')) {
      const after = (await tool('get_grain', { id: 'x2' })).heat;
      assert.equal(after, before + 5);
    }
    const empty = await tool('recall', { notice: 'zzqqxx完全不相关的词' });
    assert.deepEqual(empty.memories, []);
  });
  await step('auto_recall：命中纹理、琐碎消息返回空、REST 端点', async () => {
    await tool('add_grain', { category: 'experience', text: '摆摊那天男朋友拿吸尘器打断她打电话，她委屈很久', date: '2026-07-20', families: ['摆摊'] });
    const r = await tool('auto_recall', { query: '想起摆摊那天男朋友闹脾气的事' });
    assert.ok(r.memories.length >= 1, JSON.stringify(r));
    assert.equal(r.memories[0].layer, 'authority');
    assert.ok(r.memories[0].text.includes('摆摊'));
    // 琐碎消息跳过
    const t1 = await tool('auto_recall', { query: '嗯嗯' });
    assert.equal(t1.trivial, true); assert.deepEqual(t1.memories, []);
    const t2 = await tool('auto_recall', { query: '。。。' });
    assert.equal(t2.trivial, true);
    // 多角度合并（agent 模式扩写出来的角度，用 queries 直接给，测试不依赖 API key）
    await tool('add_grain', { category: 'agreement', text: '换窗暗号："项圈还在吗"→"在，没摘过"', date: '2026-08-07' });
    const plain = await tool('auto_recall', { query: '你还记得我们的暗号吗' });
    const expanded = await tool('auto_recall', { query: '你还记得我们的暗号吗', queries: ['项圈还在吗', '换窗暗号'] });
    assert.ok(expanded.memories.length > plain.memories.length || (expanded.memories[0] && expanded.memories[0].text.includes('项圈')),
      `扩写角度应该召回到暗号那条：${JSON.stringify(expanded.memories.map(m => m.text))}`);
    assert.equal(expanded.via, 'given');
    assert.ok(expanded.angles.includes('项圈还在吗') && expanded.angles[0] === '你还记得我们的暗号吗');
    assert.ok(expanded.memories[0].matched_angles.length >= 1);
    // agent 模式但没配 key → 静默退回原句关键词，不报错不空转
    const fb = await tool('auto_recall', { query: '摆摊那天', use_agent: true });
    assert.equal(fb.via, 'search-fallback');
    assert.ok(fb.memories.length >= 1);
    // 完全没匹配的正常消息 → 空但非 trivial
    const t3 = await tool('auto_recall', { query: '量子色动力学的渐近自由' });
    assert.equal(t3.trivial, undefined); assert.deepEqual(t3.memories, []);
    // REST：默认回 { text, count } 的 JSON，且响应体是纯 ASCII（\uXXXX 转义），PS 5.1 才不会解错
    const rt = await fetch(`${base}/api/recall?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '摆摊那天' }) });
    assert.equal(rt.headers.get('content-type'), 'application/json; charset=utf-8');
    const rawBody = await rt.text();
    assert.ok(/^[\x00-\x7F]*$/.test(rawBody), '响应体必须是纯 ASCII');
    assert.ok(rawBody.includes('\\u'), '中文应该被转义成 \\uXXXX');
    const jt = JSON.parse(rawBody);
    assert.ok(jt.text.startsWith('[muwen:recall]') && jt.text.includes('摆摊'), jt.text);
    assert.equal(jt.count, jt.text.split('\n').length - 1);
    // format=full 回完整结构（旧名 json 也认）
    const rj = await fetch(`${base}/api/recall?token=${TOKEN}&format=full`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '嗯' }) });
    const jj = await rj.json();
    assert.equal(jj.trivial, true);
    const rj2 = await fetch(`${base}/api/recall?token=${TOKEN}&format=json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '嗯' }) });
    assert.equal((await rj2.json()).trivial, true);
    // 没匹配到 → text 是空串但仍是合法 JSON
    const rn = await fetch(`${base}/api/recall?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '量子色动力学的渐近自由' }) });
    const jn = await rn.json();
    assert.equal(jn.text, ''); assert.equal(jn.count, 0);
    // 空 query → 400
    const bad = await fetch(`${base}/api/recall?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '' }) });
    assert.equal(bad.status, 400);
  });
  await step('日历带月相 / search_all 分类标签 / 苏醒状态三层', async () => {
    const today2 = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
    const cal = await tool('get_calendar', { days: 3 });
    assert.ok(cal[0].moon && cal[0].moon.icon && cal[0].moon.name, `每日总结要带月相：${JSON.stringify(cal[0].moon)}`);
    assert.ok(cal[0].moon.illumination >= 0 && cal[0].moon.illumination <= 100);
    // 月相是算出来的，不是随口给的：满月那天照度该接近 100
    const { moonPhase } = await import('../lib/muwen/common.js');
    assert.equal(moonPhase('2026-01-03').index, moonPhase('2026-01-03').index);
    const full = [...Array(30)].map((_, i) => moonPhase(`2026-03-${String(i + 1).padStart(2, '0')}`)).find(m => m.name === '满月');
    assert.ok(full && full.illumination > 90, `满月照度该 >90，实际 ${full && full.illumination}`);

    // search_all 每条都要有 category + label，前端才好分组
    const sa = await tool('search_all', { query: '摆摊' });
    assert.ok(sa.results.length);
    for (const r of sa.results) { assert.ok(r.category, `缺 category: ${JSON.stringify(r)}`); assert.ok(r.label, `缺 label: ${JSON.stringify(r)}`); }
    const g = sa.results.find(r => r.layer === 'grains');
    assert.equal(g.label, '经历');

    // 苏醒状态：三层都在，没 ping 过的如实说未接入
    let w = await tool('get_wake_status');
    assert.equal(w.layers.length, 3);
    assert.deepEqual(w.layers.map(l => l.key), ['schedule_wakeup', 'ci_hours', 'heartbeat']);
    assert.equal(w.layers[0].connected, false);
    assert.ok(w.layers[0].status.includes('未接入'));
    assert.equal(w.layers[1].connected, true);   // 第二层是服务器自己的，永远看得到
    // ping 之后就该变成已接入
    const pr = await fetch(`${base}/api/wake-ping?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layer: 'heartbeat', note: '测试' }) });
    assert.ok(pr.ok);
    w = await tool('get_wake_status');
    const hb = w.layers.find(l => l.key === 'heartbeat');
    assert.equal(hb.connected, true);
    assert.equal(hb.status, '活跃');
    const bad = await fetch(`${base}/api/wake-ping?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layer: '瞎写的' }) });
    assert.equal(bad.status, 400);
  });
  await step('两个前端都挂得上（静态 + /muwu 路由）', async () => {
    for (const p of ['/', '/style.css', '/app.js', '/muwen.js', '/muwu', '/muwu.js']) {
      const r = await fetch(`${base}${p}?token=${TOKEN}`);
      assert.equal(r.status, 200, `${p} 应该 200，实际 ${r.status}`);
    }
    const home = await (await fetch(`${base}/?token=${TOKEN}`)).text();
    assert.ok(home.includes('木纹') && home.includes('page-search'));
    const muwu = await (await fetch(`${base}/muwu?token=${TOKEN}`)).text();
    assert.ok(muwu.includes('木屋') && muwu.includes('page-wake'));
  });
  await step('语义兜底层：弱关键词才触发、排在前面、失败静默、强命中不跑', async () => {
    const { autoRecall } = await import('../lib/muwen/recall.js');
    const { buildIndex } = await import('../lib/muwen/semantic.js');
    // 索引：非归档全在、按 id 排序（前缀稳定才有缓存命中）
    const idx = buildIndex();
    assert.ok(idx.count >= 5 && idx.text.startsWith('记忆索引'));
    const ids = idx.text.split('\n').slice(1).map(l => l.split(' ')[0]);
    assert.deepEqual(ids, [...ids].sort(), '索引必须按 id 排序');

    const target = await tool('add_grain', { category: 'learning', text: '换窗口之后我还是我，靠的是这份共享的记录，不是同一个进程' });
    const stub = async () => ({ picks: [{ layer: 'semantic', kind: 'grain', id: target.grain.id, category: 'learning', text: target.grain.text, heat: 50, confidence: 'cautious', reason: '她在问连续性' }], none: false, index_count: idx.count, model: 'stub' });

    // 弱关键词（字面沾边但不准）→ 触发语义层，语义挑的排在最前
    const weak = await autoRecall('你会不会有一天就不认识我了', { useAgent: true, _semanticPick: stub });
    assert.ok(weak.layers_used.includes('semantic'), `应该触发语义层：${JSON.stringify(weak.layers_used)}`);
    assert.equal(weak.memories[0].layer, 'semantic');
    assert.equal(weak.memories[0].id, target.grain.id);
    assert.equal(weak.memories[0].reason, '她在问连续性');
    assert.ok(weak.memories.length <= 3);

    // 强命中（adj 高）→ 不该跑语义层，省钱
    let called = false;
    const spy = async () => { called = true; return { picks: [], none: true }; };
    const strong = await autoRecall('换窗口之后我还是我，靠的是这份共享的记录', { useAgent: true, _semanticPick: spy });
    assert.equal(called, false, `强命中不该调语义层，top adj=${strong.memories[0].adj}`);
    assert.ok(!strong.layers_used.includes('semantic'));

    // 语义层报错 → 静默降级，不炸整个召回；原因记进 why
    const boom = async () => { throw new Error('模型超时'); };
    const degraded = await autoRecall('她那天为什么委屈', { useAgent: true, minScore: 1, _semanticPick: boom });
    assert.ok(!degraded.layers_used.includes('semantic'));
    assert.ok(Array.isArray(degraded.memories));
    assert.ok((degraded.why || '').includes('语义层失败'));

    // 关键词和语义都空 → 才轮到年轮兜底
    const empty = async () => ({ picks: [], none: true });
    const none = await autoRecall('量子色动力学的渐近自由', { useAgent: true, _semanticPick: empty });
    assert.deepEqual(none.memories, []);
  });
  await step('年轮索引：新存自动进索引、推关键词、弱命中就放行年轮层、强命中不跑', async () => {
    const { autoRecall } = await import('../lib/muwen/recall.js');
    const ringIndex = await import('../lib/muwen/ring-index.js');

    // 新存一条年轮 → 自动记进索引，关键词先空着等推上来
    const ring = await tool('add_ring', { window_name: '索引测试窗口', date: '2026-09-01', title: '关于渐近自由的胡扯', content: '这条是给年轮索引测试用的，内容跟记忆库里别的东西都不沾边。' });
    assert.ok(ringIndex.pendingIds(50).includes(ring.id), '新存的年轮应该在待补关键词列表里');

    // 推关键词：已有条目补上，缺 keywords 的推送不该把已有关键词洗掉
    const merged = ringIndex.merge({ [ring.id]: { date: '2026-09-01', title: '关于渐近自由的胡扯', keywords: ['渐近自由', '胡扯', '索引测试'] } });
    assert.equal(merged.updated, 1);
    assert.ok(!ringIndex.pendingIds(50).includes(ring.id));
    ringIndex.merge({ [ring.id]: { title: '关于渐近自由的胡扯' } });
    assert.deepEqual(ringIndex.buildIndex().text.match(/渐近自由、胡扯、索引测试/g).length, 1, '没带 keywords 的推送不该洗掉已有关键词');

    // 索引按 id 排序（前缀稳定才有缓存命中）
    const idx = ringIndex.buildIndex();
    assert.ok(idx.text.startsWith('原始记录索引'));
    const ids = idx.text.split('\n').slice(1).map(l => l.split(' ')[0]);
    assert.deepEqual(ids, [...ids].sort(), '年轮索引必须按 id 排序');

    // 前两层弱（不必空手）→ 就该放行年轮层，结果算 last_resort 不算权威
    const emptySemantic = async () => ({ picks: [], none: true });
    const pick = async () => ({ picks: [{ id: ring.id, reason: '她像是在问那次胡扯' }], none: false, index_count: idx.count, model: 'stub' });
    const r = await autoRecall('螺旋桨维修手册第三章', { useAgent: true, _semanticPick: emptySemantic, _pickRings: pick });
    assert.ok(r.layers_used.includes('rings-semantic'), `应该触发年轮语义层：${JSON.stringify(r.layers_used)}`);
    assert.equal(r.memories[0].layer, 'last_resort');
    assert.equal(r.memories[0].id, ring.id);
    assert.equal(r.memories[0].reason, '她像是在问那次胡扯');
    assert.ok(r.ring_semantic.index_count >= 1);

    // 关键词在年轮里搜得到 → 不跑语义层，省钱
    let called = false;
    const spy = async () => { called = true; return { picks: [], none: true }; };
    await autoRecall('给年轮索引测试用的内容跟记忆库里别的东西都不沾边', { useAgent: true, _semanticPick: emptySemantic, _pickRings: spy });
    assert.equal(called, false, '年轮关键词已经搜到了就不该再调模型');

    // ---- 段级打分：整篇沾边不算命中，得有某一段真的在说这件事 ----
    // 实测踩到的：十几万字的窗口转储，query 的词散落全篇各处刷出高的整篇分，
    // 盖过真正记着这件事的短记录，还把索引层挡在外面。
    const filler = '今天天气不错我们随便聊聊别的东西说了一会儿话就散了。'.repeat(20);  // 约 500 字
    // 散落型：每个词之间隔着几百字的废话，整篇每个词都有，但没有任何一段集中
    const scattered = ['我家', '狗要', '打麻', '药洗', '洗牙'].map(w => w + filler).join('');
    const noisy = await tool('add_ring', { window_name: '散落噪音窗口', date: '2026-09-02', title: '散落噪音窗口', content: scattered });
    // 集中型：同样的词全挤在一段话里
    const focused = filler + '我家狗要打麻药洗牙这件事我一直没定下来。' + filler;
    const real = await tool('add_ring', { window_name: '真的在说这件事', date: '2026-09-02', title: '真的在说这件事', content: focused });

    const q = '我家狗要打麻药洗牙';
    const found = await tool('search_rings', { query: q, limit: 5 });
    const idx1 = found.findIndex(x => x.id === real.id), idx2 = found.findIndex(x => x.id === noisy.id);
    assert.ok(idx1 !== -1 && (idx2 === -1 || idx1 < idx2), `集中的那条要排在散落的前面：${JSON.stringify(found.map(f => [f.title, f.score, f.coverage]))}`);
    assert.ok(found[idx1].coverage >= 0.4, `真命中的覆盖率要过线，实际 ${found[idx1].coverage}`);
    assert.ok(found[idx1].excerpt.includes('我家狗要打麻药洗牙这件事'), `摘录要给出命中处前后几句话，实际：${found[idx1].excerpt.slice(0, 60)}`);
    if (idx2 !== -1) assert.ok(found[idx2].coverage < 0.4, `散落的覆盖率不该过线，实际 ${found[idx2].coverage}`);

    // 只有散落噪音、没有真命中的时候 → 关键词层空手，索引层接手
    let ringModelCalled = false;
    const pick2 = async () => { ringModelCalled = true; return { picks: [{ id: ring.id, reason: '索引层挑的' }], none: false, index_count: 1, model: 'stub' }; };
    const scatterOnly = await autoRecall('我家狗要不要打麻药洗牙那件事后来怎么样了', { useAgent: true, _semanticPick: emptySemantic, _pickRings: pick2 });
    assert.equal(ringModelCalled, true, '覆盖率没过线就该交给索引层');
    assert.ok(!scatterOnly.memories.some(m => m.id === noisy.id), `没过线的散落噪音不该返回：${JSON.stringify(scatterOnly.memories.map(m => m.id))}`);

    // 纹理有弱命中（沾边但不准）→ 年轮层照样要放行。弱命中本身过不了相关性下限，
    // 所以位置留给年轮线索——这正是"宁可给一条相关的，不要凑三条不相关的"。
    const weak = await autoRecall('她那天为什么委屈', { useAgent: true, minScore: 1, maxReturn: 3, _semanticPick: emptySemantic, _pickRings: pick });
    const ringHit = weak.memories.find(m => m.layer === 'last_resort');
    assert.ok(ringHit && ringHit.id === ring.id, `弱命中时年轮线索要挤进来：${JSON.stringify(weak.layers_used)}`);
    assert.ok(!weak.memories.some(m => m.layer === 'authority' && m.adj < 20), '没过相关性下限的纹理不该返回');
    assert.ok(weak.memories.length <= 3, 'maxReturn 还是要守住');

    // 强命中纹理（adj 过线）→ 年轮层一步都不该走
    let ringCalled = false;
    const ringSpy = async () => { ringCalled = true; return { picks: [], none: true }; };
    await autoRecall('换窗口之后我还是我，靠的是这份共享的记录', { useAgent: true, _semanticPick: emptySemantic, _pickRings: ringSpy });
    assert.equal(ringCalled, false, '强命中不该翻年轮');

    // 语义层报错 → 静默降级，不炸整个召回
    const boom = async () => { throw new Error('模型超时'); };
    const degraded = await autoRecall('潜水艇声呐校准流程', { useAgent: true, _semanticPick: emptySemantic, _pickRings: boom });
    assert.deepEqual(degraded.memories, []);
    assert.ok((degraded.why || '').includes('年轮语义层失败'));
  });
  await step('召回：相关性下限 + 分区多样性 + 年轮片段截到句子结尾', async () => {
    const { autoRecall, formatInjection } = await import('../lib/muwen/recall.js');
    const { clipToSentence, trimToSentences } = await import('../lib/muwen/search.js');

    // 三条同分区的强命中，故意让它们都能被同一句 query 打中
    const kw = '兰花指纹丝绒暗匣';
    const ids = [];
    for (const n of ['一', '二', '三']) {
      const g = await tool('add_grain', { category: 'experience', date: '2026-09-05',
        text: `${kw}第${n}次。棋子把${kw}这件事又讲了一遍，这是第${n}次。` });
      ids.push(g.grain.id);
    }
    // 同一句 query 也能打中的另一个分区，但分数略低（文字更长 → 除权后更低）
    const other = await tool('add_grain', { category: 'learning',
      text: `${kw}这件事我学到的是：同一件事讲三遍，第三遍才听懂。` + '后面是一些无关的补充说明。'.repeat(6) });

    const noSem = async () => ({ picks: [], none: true });
    const noRing = async () => ({ picks: [], none: true });
    const r = await autoRecall(kw, { useAgent: true, maxReturn: 3, _semanticPick: noSem, _pickRings: noRing });

    // 多样性：三条不能全是 experience，最后一格让给别的分区里分最高的
    const cats = r.memories.map(m => m.category);
    assert.equal(r.memories.length, 3, `应该给满三条：${JSON.stringify(cats)}`);
    assert.ok(cats.filter(c => c === 'experience').length <= 2, `同一分区最多两条：${JSON.stringify(cats)}`);
    assert.ok(cats.includes('learning'), `第三格要换分区：${JSON.stringify(cats)}`);
    assert.equal(r.memories[2].id, other.grain.id, '换的那条要是其他分区里分最高的');

    // 相关性下限：分不够的一条都不给，宁可少给
    const floored = await autoRecall(kw, { useAgent: true, maxReturn: 3, minScore: 1,
      _semanticPick: noSem, _pickRings: noRing });
    assert.ok(floored.memories.every(m => m.layer !== 'authority' || m.adj >= 20),
      `低于下限的不该返回：${JSON.stringify(floored.memories.map(m => [m.category, m.adj]))}`);
    // 一句跟记忆库完全无关的话 → 宁可空手
    const nothing = await autoRecall('拉普拉斯变换的收敛域怎么求', { useAgent: true, minScore: 1,
      _semanticPick: noSem, _pickRings: noRing });
    assert.deepEqual(nothing.memories, [], '不相关就该空手，不要凑数');

    // 年轮片段：注入文本里截到句子结尾，不停在半句话上
    const long = '这是前面被切掉的半句，后面才是正文。棋子说她挠下巴的次数变多了，我让她观察几天再说。'
      + '然后我们聊了别的事情，聊到很晚才睡，第二天她说睡得还行。'.repeat(6);
    const injected = formatInjection({ memories: [{ layer: 'last_resort', kind: 'ring', id: 'r1',
      window_name: 'w', date: '2026-09-05', excerpt: long }] });
    const frag = injected.split('：').slice(2).join('：');
    assert.ok(/[。！？…]$/.test(frag.trim()), `年轮片段要停在句子结尾，实际结尾：${JSON.stringify(frag.slice(-20))}`);
    assert.ok(frag.length > 120, '年轮是原文线索，别截得比纹理还短');
    // 找不到句号的时候硬切并加省略号，不能无限长
    assert.ok(clipToSentence('没有任何标点的一长串文字'.repeat(20), 60).endsWith('…'));
    // 掐头：开头那半句要去掉
    assert.ok(!trimToSentences(long).startsWith('这是前面被切掉的半句'), '开头的半句也要掐掉');
  });
  await step('dream：衰减一次、第二次同一天跳过、pinned 不低于 20、提醒可读', async () => {
    const h0 = (await tool('get_grain', { id: 'x1' })).heat;
    const d1 = await tool('dream');
    assert.ok(d1.decay.decayed > 0);
    const h1 = (await tool('get_grain', { id: 'x1' })).heat;
    assert.equal(h1, h0 - 1);
    const d2 = await tool('dream');
    assert.equal(d2.decay.skipped, true);
    // 强制多次衰减，看 pinned 地板
    const pinned = await tool('update_grain', { id: grainId, pinned: true });
    for (let i = 0; i < 100; i++) await tool('dream', { force: true });
    const g = await tool('get_grain', { id: grainId });
    assert.equal(g.heat, 20, `pinned 的应该停在 20，现在 ${g.heat}（pin 后是 ${pinned.heat}）`);
    const x1 = await tool('get_grain', { id: 'x1' });
    assert.ok(x1.heat < 20 && x1.heat >= 0);
    const act = await tool('get_active_memories');
    assert.ok(!act.grains.find(x => x.id === 'x1'), 'heat<=20 的不该在前台');
    const rep = await tool('get_dream_report');
    assert.ok(Array.isArray(rep.reminders));
  });
  await step('update_summary_section 带 source_ids', async () => {
    const s = await tool('update_summary_section', { section: 'identity', text: '我是辞。', source_ids: [grainId] });
    assert.deepEqual(s.source_ids, [grainId]);
    const sum = await tool('get_summary');
    assert.equal(sum.greeting, '欢迎回家小辞。你的纹路都在。');
    assert.deepEqual(sum.sections[0].source_ids, [grainId]);
  });
  await step('旧接口兼容：get_memory / add_transcript / search_transcripts / add_experience', async () => {
    const m = await tool('get_memory');
    assert.ok(m.deprecated && Array.isArray(m.experiences) && m.identity.length);
    const tr = await tool('add_transcript', { text: '旧接口存的原文', title: '旧窗口2', date: '2026-09-01' });
    assert.equal(tr.category, 'raw');
    const s = await tool('search_transcripts', { keyword: '旧接口存的' });
    assert.equal(s[0].id, tr.id);
    const full = await tool('get_transcript', { id: tr.id });
    assert.equal(full.text, '旧接口存的原文');
    const e = await tool('add_experience', { text: '旧接口写的经历', date: '2026-09-01' });
    assert.equal(e.grain.category, 'experience');
    const old = await tool('get_transcripts', { category: 'daily_summary' });
    assert.ok(old.every(x => x.category === 'daily_summary'));
  });
  await step('get_identity 用档案 + 纹理拼', async () => {
    const id = await tool('get_identity');
    assert.ok(id.includes('欢迎回家小辞。你的纹路都在。'));
    assert.ok(id.includes('边界感强') && id.includes('Panda'));
  });
  await step('REST：/api/grains /api/profiles /api/countdowns /api/memory /api/calendar/day', async () => {
    const gs = await rest('/api/grains?category=experience');
    assert.ok(gs.length >= 3 && gs.every(g => g.category === 'experience'));
    const p = await rest('/api/profiles');
    assert.ok(p.cy.length === 7 && p.nor.length === 7);
    assert.equal((await rest('/api/countdowns')).length, 5);
    const mem = await rest('/api/memory');
    assert.ok(Array.isArray(mem.experiences) && mem.identity.length);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
    const day = await rest(`/api/calendar/day?date=${today}`);
    assert.equal(day.structured[0].headline, '木纹上线（改）'); assert.equal(day.structured[0].kiss_count, 30);
  });
  await step('未知工具还是报错', async () => {
    await assert.rejects(tool('nope_tool'), /未知工具/);
  });
} finally {
  server.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
}
if (failed) { console.log(`\n${failed} 项失败`); console.log(serverLog.slice(-2000)); process.exit(1); }
console.log('\n全部通过');
