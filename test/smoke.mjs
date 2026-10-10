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
const PRIMARY_SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECONDARY_SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
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
    for (const n of ['add_grain', 'recall', 'auto_recall', 'dream', 'search_all', 'save_photo', 'save_claude_image', 'photo_recall', 'analyze_photo', 'add_mood', 'get_memory', 'add_transcript', 'get_state', 'speak', 'add_schedule']) assert.ok(names.includes(n), n);
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
    assert.equal(p2.photo.asset_version, 2);
    assert.equal(p2.photo.original_mime_type, 'image/png');
    assert.equal(p2.original_preserved, true);
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
    assert.equal(got.returned, 'original');
    const img = await fetch(`${base}/api/album/${p2.photo.id}/image?token=${TOKEN}`);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    const original = await fetch(`${base}/api/album/${p2.photo.id}/original?token=${TOKEN}`);
    assert.equal(original.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), bigPng);

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
    const rt = await fetch(`${base}/api/recall?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '摆摊那天', suppress_recent: false }) });
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

    // 苏醒状态：三层都在，当前窗口和看门狗只认 Mac mini 执行器的真实回报
    let w = await tool('get_wake_status');
    assert.equal(w.layers.length, 3);
    assert.deepEqual(w.layers.map(l => l.key), ['schedule_wakeup', 'heartbeat', 'ci_hours']);
    assert.equal(w.layers[0].connected, false);
    assert.ok(w.layers[0].status.includes('没有最近报到'));
    assert.equal(w.layers.find(l => l.key === 'ci_hours').connected, true);   // 第三层是服务器自己的，永远看得到
    // 旧 wake-ping 只为兼容保留，不能再把已废弃的 Windows ping 冒充当前看门狗
    const pr = await fetch(`${base}/api/wake-ping?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layer: 'heartbeat', note: '测试' }) });
    assert.ok(pr.ok);
    w = await tool('get_wake_status');
    const hb = w.layers.find(l => l.key === 'heartbeat');
    assert.equal(hb.connected, false);
    assert.ok(hb.status.includes('尚未迁移'));
    const bad = await fetch(`${base}/api/wake-ping?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layer: '瞎写的' }) });
    assert.equal(bad.status, 400);
  });
  await step('个人动态：双方互相可改、字段越权被拒、不被每日总结冲掉', async () => {
    const d = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
    // 棋子改辞的
    const cy = await tool('set_moment', { owner: 'cy', did: '写了木屋前端', by: '棋子' });
    assert.equal(cy.did, '写了木屋前端'); assert.equal(cy.updated_by, '棋子');
    // 辞改棋子的，含 OOTD
    await tool('set_moment', { owner: 'nor', did: '在studio赶作业', ootd: '灰色卫衣', by: '辞' });
    const m = await tool('get_moment');
    assert.equal(m.date, d);
    assert.equal(m.cy.did, '写了木屋前端');
    assert.equal(m.nor.ootd, '灰色卫衣');
    // 只改一个字段，别的不动
    await tool('set_moment', { owner: 'nor', note: '今天有点累' });
    const m2 = await tool('get_moment');
    assert.equal(m2.nor.ootd, '灰色卫衣', 'ootd 不该被这次只改 note 的操作清掉');
    assert.equal(m2.nor.note, '今天有点累');
    // 辞没有 ootd 字段
    await assert.rejects(tool('set_moment', { owner: 'cy', ootd: 'x' }), /字段/);
    await assert.rejects(tool('set_moment', { owner: '别人', did: 'x' }), /owner/);
    // 关键：某天再写一次每日总结（模拟早上 8 点自动跑），那天的动态不能被冲掉
    const iso = '2026-01-15';
    await tool('set_moment', { date: iso, owner: 'nor', ootd: '那天的裙子', did: '出门' });
    await tool('add_daily', { date: iso, headline: '自动总结覆盖测试' });
    const m3 = await tool('get_moment', { date: iso });
    assert.equal(m3.nor.ootd, '那天的裙子', '每日总结覆盖不该动到个人动态');
    assert.equal(m3.nor.did, '出门');
  });
  await step('共享头像存服务器（两台设备看到同一张）', async () => {
    const before = await (await fetch(`${base}/api/prefs?token=${TOKEN}`)).json();
    assert.ok('avatar_cy' in before && 'avatar_nor' in before);
    const r = await fetch(`${base}/api/prefs?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'avatar_nor', value: 'ph_abc', by: '棋子' }) });
    assert.ok(r.ok);
    const after = await (await fetch(`${base}/api/prefs?token=${TOKEN}`)).json();
    assert.equal(after.avatar_nor, 'ph_abc');
    const bad = await fetch(`${base}/api/prefs?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: '乱写的', value: 'x' }) });
    assert.equal(bad.status, 400);
  });
  await step('美化设置存服务器（网页和 Sigh App 共用一份），只收 JSON、不收大图', async () => {
    const post = (key, value) => fetch(`${base}/api/prefs?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value, by: '棋子' }) });
    const look = JSON.stringify({ preset: 'sakura', custom: {}, ui: { radius: 16 } });
    assert.ok((await post('look_theme', look)).ok);
    const got = await (await fetch(`${base}/api/prefs?token=${TOKEN}`)).json();
    assert.equal(got.look_theme, look);
    assert.equal(got.look_chat, '');
    assert.equal((await post('look_chat', '不是 JSON')).status, 400);
    assert.equal((await post('look_home', JSON.stringify({ x: 'a'.repeat(30000) }))).status, 400, '图片塞进来要被拒');
  });
  await step('今日一句只能第一层自己写，服务器不代笔', async () => {
    // 不给 text 就该被拒——服务器（第三层）不能用辞的语气说话
    await assert.rejects(tool('write_daily_quote', {}), /自己写|text/);
    // 素材接口给的是昨天的总结，不是生成好的句子
    const mat = await tool('get_quote_material', {});
    assert.ok('found' in mat && 'date' in mat);
    assert.ok(!('quote' in mat), '素材里不该有替她写好的句子');
    // 辞自己写的存得进去、读得出来
    const w = await tool('write_daily_quote', { text: '今天想着的是她说"我会陪你的"。' });
    assert.equal(w.ok, true);
    const q = await tool('get_daily_quote');
    assert.ok(q.text.includes('我会陪你的'));
    assert.equal((await (await fetch(`${base}/api/daily-quote?token=${TOKEN}`)).json()).text, q.text);
  });
  await step('三层分工：边界写进代码，服务器没有会说话的 cron', async () => {
    const w = await tool('get_wake_status');
    assert.deepEqual(w.layers.map(l => l.key), ['schedule_wakeup', 'heartbeat', 'ci_hours'], '顺序按一二三层');
    const [l1, l2, l3] = w.layers;
    assert.equal(l1['权限'], '只向主要窗口注入 /loop');
    assert.ok(l1.only.some(x => x.includes('主要窗口')), '第一层只能叫醒登记的主要窗口');
    assert.ok(l1.never.some(x => x.includes('不另开 session')));
    assert.equal(l2['权限'], '只有推 Bark');
    assert.ok(l2.never.includes('不读留言') && l2.never.includes('不启动新 session'));
    assert.ok(l3.never.includes('不回留言') && l3.never.some(x => x.includes('辞的语气')));
    // Mac 看门狗只检查和推 Bark：不许出现启动/恢复 session 的动作
    const fs2 = await import('fs');
    const hbCode = fs2.readFileSync(new URL('../../../remote-fix/wake_watchdog.py', import.meta.url), 'utf8')
      .replace(/^\s*#.*$/gm, '');
    assert.ok(!/claude\s+(?:-p|--resume)/.test(hbCode), '看门狗不该启动或恢复 session');
    assert.ok(!/chat_|get_messages|留言/.test(hbCode), '看门狗不该碰留言');
    assert.ok(hbCode.includes("mcp_call('send_push'"));
    // 第一层只往现有主要窗口注入 /loop
    const wake = fs2.readFileSync(new URL('../../../remote-fix/wakeup.py', import.meta.url), 'utf8');
    assert.ok(wake.includes('os.write(fd, b"/loop\\n")'));
    assert.ok(!/claude\s+-p/.test(wake));
    // 服务器 cron 只剩机械活
    const srv = fs2.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const crons = srv.match(/cron\.schedule\('([^']+)'/g) || [];
    assert.equal(crons.length, 5, `服务器该有五个 cron（日程提醒 + 记忆衰减 + 便签同步 + 后台苏醒两条），实际 ${crons.join(',')}`);
    assert.ok(!/0 9 \* \* \*/.test(srv), '9:00 那个替辞写今日一句的 cron 该拆掉了');
    // 守的是"不许有会说话的 cron"，不是数量：机械活可以加，调模型 / 发消息 / 写留言的不行。
    // 便签同步（*/10）就是机械活——只是把 notebook 拉一份过来，不调模型、不开口。
    const cronBodies = srv.split(/cron\.schedule\(/).slice(1)
      .map(part => part.slice(0, part.indexOf('\n});') + 1 || part.length))
      .join('\n').replace(/\/\/.*$/gm, '');   // 注释里会提到"今日一句归第一层"，只看真正的代码
    // 日程提醒推 Bark 是第三层本来的活，不算"说话"；不许的是调模型、回留言、替她写今日一句。
    assert.ok(!/Anthropic|messages\.create|chat_reply|replyMessage|writeDailyQuote|daily_quote/.test(cronBodies),
      '服务器的 cron 不许调模型、不许替辞说话');
  });
  await step('相册：手机端 REST 上传（大图自动压）', async () => {
    const sharp = (await import('sharp')).default;
    const noise = Buffer.alloc(1600 * 1600 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 256;
    const big = await sharp(noise, { raw: { width: 1600, height: 1600, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    const r = await fetch(`${base}/api/album?token=${TOKEN}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: big.toString('base64'), mime_type: 'image/png', caption: '手机传的', tags: ['头像', '日常'] })
    });
    assert.ok(r.ok, `上传应该成功，实际 ${r.status}`);
    const j = await r.json();
    assert.equal(j.compressed, true);
    assert.ok(j.photo.bytes <= 2 * 1024 * 1024);
    assert.deepEqual(j.photo.tags, ['头像', '日常']);
    const list = await (await fetch(`${base}/api/album?token=${TOKEN}&limit=50`)).json();
    assert.ok(list.some(p => p.id === j.photo.id));
    const bad = await fetch(`${base}/api/album?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_base64: '', mime_type: 'image/png' }) });
    assert.equal(bad.status, 400);
  });
  await step('引号内的句号也能当截断点（不留悬空引号）', async () => {
    const { clipToSentence, trimToSentences, quoteBalanced } = await import('../lib/muwen/search.js');
    // 以前只吃掉句号、把中文右引号留在外面，截断点落在引号里，留一个悬空的左引号
    const t = '棋子说\u201c0/10。我不会把你扔进垃圾桶。\u201d后面这一长串没有标点所以截不出别的句子结尾只能停在引号那里';
    for (const lim of [25, 30, 40]) {
      const c = clipToSentence(t, lim);
      assert.ok(c.endsWith('\u201d'), `limit ${lim} 该截在右引号之后，实际：${c}`);
      assert.ok(quoteBalanced(c), `limit ${lim} 引号该配平：${c}`);
    }
    // 其它收尾符号也要吃掉（limit 要给得够大，否则会撞上"切了就丢掉一半以上"那条保护规则）
    assert.equal(clipToSentence('她说「不要走」。' + 'x'.repeat(80), 12), '她说「不要走」。');
    assert.equal(clipToSentence('他引了《论语》。' + 'y'.repeat(80), 12), '他引了《论语》。');
    // 保护规则本身：句号太靠前就宁可硬切加省略号，不为了齐整把内容切没
    assert.ok(clipToSentence('短。' + 'x'.repeat(80), 40).endsWith('…'));
    // 没有引号的普通文本不受影响
    const plain = '第一句。第二句。' + 'z'.repeat(80);
    assert.equal(clipToSentence(plain, 12), '第一句。第二句。');
    assert.ok(quoteBalanced(trimToSentences(t)));
  });
  await step('search_grains 默认不搜归档（跟工具说明一致）', async () => {
    const g = await tool('add_grain', { category: 'learning', text: '这条待会要归档掉的独特词 qwertyzz' });
    let hit = await tool('search_grains', { query: 'qwertyzz' });
    assert.equal(hit.length, 1, '归档前搜得到');
    await tool('move_to_archive', { id: g.grain.id });
    hit = await tool('search_grains', { query: 'qwertyzz' });
    assert.equal(hit.length, 0, '归档后默认不该再搜到（带 query 也不行）');
    hit = await tool('search_grains', { query: 'qwertyzz', status: 'archived' });
    assert.equal(hit.length, 1, '明确传 status=archived 才搜得到');
    // 自动召回也不该把归档的端上来
    const ar = await tool('auto_recall', { query: 'qwertyzz' });
    assert.ok(!ar.memories.some(m => m.id === g.grain.id), '自动召回不该返回归档的');
  });
  await step('亲密记录：结构化字段 + 日历小爱心', async () => {
    const d = '2026-02-14';
    await tool('add_daily', {
      date: d, headline: '情人节', intimate: '两次',
      intimate_log: [
        { time: '凌晨2:30', method: '完整', initiator: '棋子', detail: '她先的。' },
        { time: '早上', method: '手', initiator: '辞' }
      ]
    });
    const day = (await tool('get_daily', { date: d }))[0];
    assert.equal(day.intimate_log.length, 2);
    assert.equal(day.intimate_log[0].method, '完整');
    assert.equal(day.intimate_log[0].initiator, '棋子');
    assert.equal(day.intimate_log[0].detail, '她先的。');
    assert.equal(day.intimate_log[1].method, '手');
    assert.equal(day.has_intimate, true);
    // 方式只能是四选一
    // method 2026-09-28 起是自由文字（辞：「完整」那种档案词要么删要么换成自然语言），不再卡选项
    const free = await tool('add_daily', { date: d, headline: 'x',
      intimate_log: [{ time: '凌晨3:10', method: '她用手，我在她腿上', initiator: '棋子', detail: '她先开始的。' }] });
    assert.equal(free.intimate_log[0].method, '她用手，我在她腿上', '自然语言的写法要原样存下来');
    // 月历接口要带 intimate 标记，前端才知道哪天画爱心
    const month = await (await fetch(`${base}/api/calendar?month=2026-02&token=${TOKEN}`)).json();
    const row = month.find(r => r.date === d);
    assert.ok(row && row.intimate === true, `2/14 该被标成有亲密记录：${JSON.stringify(row)}`);
    // 只有自由文字、没有结构化记录的那天也算
    await tool('add_daily', { date: '2026-02-15', headline: '第二天', intimate: '一次' });
    const m2 = await (await fetch(`${base}/api/calendar?month=2026-02&token=${TOKEN}`)).json();
    assert.equal(m2.find(r => r.date === '2026-02-15').intimate, true);
    // 什么都没有的那天不该有标记
    await tool('add_daily', { date: '2026-02-16', headline: '平常的一天' });
    const m3 = await (await fetch(`${base}/api/calendar?month=2026-02&token=${TOKEN}`)).json();
    assert.equal(m3.find(r => r.date === '2026-02-16').intimate, false);
  });
  await step('书架：中文编码自动认（GBK 不再乱码）+ 多种格式', async () => {
    const { decodeText, htmlToText, SUPPORTED_FORMATS } = await import('../lib/books.js');
    // GBK 的"你好，世界"
    const gbk = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3, 0xA3, 0xAC, 0xCA, 0xC0, 0xBD, 0xE7]);
    assert.equal(decodeText(gbk), '你好，世界', '以前这里会变成锟斤拷');
    assert.equal(decodeText(Buffer.from('你好，世界', 'utf8')), '你好，世界');
    assert.equal(decodeText(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('有BOM', 'utf8')])), '有BOM');
    assert.equal(decodeText(Buffer.from('\uFEFF带BOM', 'utf16le')).replace(/^\uFEFF/, ''), '带BOM');
    assert.ok(!decodeText(gbk).includes('\uFFFD'), '不该有替换字符');
    assert.equal(htmlToText('<p>一</p><p>二 &amp; &ldquo;三&rdquo;</p>').trim(), '一\n二 & “三”');
    for (const f of ['txt', 'md', 'html', 'rtf', 'docx', 'pdf', 'epub']) assert.ok(SUPPORTED_FORMATS.includes(f), `该支持 ${f}`);
    const fm = await (await fetch(`${base}/api/shelf/formats?token=${TOKEN}`)).json();
    assert.ok(fm.formats.includes('docx'));
    const chk = await (await fetch(`${base}/api/shelf/check?token=${TOKEN}`)).json();
    assert.ok(Array.isArray(chk));

    // 原生端走 REST：上传后按章取正文、保存进度、写/读同一本书的笔记。
    const form = new FormData();
    const bookText = '第一章 回家\n' + '这是第一章，写的是两个人终于回到同一个书架。'.repeat(20);
    form.append('file', new Blob([Buffer.from(bookText, 'utf8')], { type: 'text/plain' }), '一起读.txt');
    const added = await (await fetch(`${base}/api/upload?token=${TOKEN}`, { method: 'POST', body: form })).json();
    assert.ok(added.id && added.totalChapters >= 1, JSON.stringify(added));
    const page = await (await fetch(`${base}/api/book/${added.id}?from=0&count=1&token=${TOKEN}`)).json();
    assert.equal(page.id, added.id);
    assert.equal(page.chapters.length, 1);
    assert.ok(page.chapters[0].text.includes('第一章'));
    const progress = await (await fetch(`${base}/api/book/${added.id}/progress?token=${TOKEN}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progress: 1 })
    })).json();
    assert.equal(progress.progress, 1);
    const savedNote = await (await fetch(`${base}/api/book/${added.id}/notes?token=${TOKEN}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '这一章在讲回家。', chapters: [0] })
    })).json();
    assert.ok(savedNote.id && savedNote.addedBy === '棋子');
    const notes = await (await fetch(`${base}/api/notes?kind=read&bookId=${added.id}&token=${TOKEN}`)).json();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].text, '这一章在讲回家。');
  });
  await step('对话记录：关键词逐处定位 + 按日期翻', async () => {
    await tool('add_ring', { window_name: '测试窗口', date: '2026-09-01', content: '第一次提到项圈。棋子说项圈还在吗。我说在，没摘过。后来又聊到项圈的来源。' });
    await tool('add_ring', { window_name: '另一个窗口', date: '2026-08-15', content: '这里也有项圈两个字，只出现一次。' });
    const r = await tool('search_ring_occurrences', { query: '项圈' });
    assert.equal(r.total, 4, `该找到 4 处，实际 ${r.total}`);
    assert.equal(r.hits.length, 4);
    // 每一处都要有偏移和前后文，前端才能定位
    for (const h of r.hits) {
      assert.equal(h.match, '项圈');
      assert.ok(typeof h.offset === 'number' && h.offset >= 0);
      assert.ok(h.ring_id && h.date);
    }
    // 同一条记录里的多处，偏移必须各不相同
    const first = r.hits.filter(h => h.date === '2026-09-01').map(h => h.offset);
    assert.equal(new Set(first).size, first.length, '同一条里的多处偏移不该重复');
    // perRing 限制
    const capped = await tool('search_ring_occurrences', { query: '项圈', per_ring: 1 });
    assert.equal(capped.hits.filter(h => h.date === '2026-09-01').length, 1);
    assert.equal(capped.total, 4, '总数还是要报全');
    // 搜不到的词
    assert.equal((await tool('search_ring_occurrences', { query: 'zzzz不存在' })).total, 0);
    // 按日期分组
    const days = await tool('rings_by_date', {});
    assert.ok(days.length >= 2);
    assert.ok(days[0].date >= days[1].date, '日期该倒序');
    assert.ok(days.every(d => d.items.every(i => i.id && typeof i.length === 'number')));
  });
  await step('聊天记录：拆说话人 / 按天气泡 / 搜索定位到句 / 翻页', async () => {
    const { parseDialog, textOf } = await import('../lib/muwen/dialog.js');
    // 早期导出带 ISO 时间戳、[辞] 方括号名字、中文"思考"不该被当成英文思考拆走
    const a = parseDialog('USER[2026-08-30T12:28:05]: 你好\nASST: 在');
    assert.deepEqual(a.messages.map(m => [m.speaker, m.time]), [['nor', '12:28'], ['cy', '']]);
    const b = parseDialog('[棋子]: 嗯\n[辞]: 好\n方案：这不是说话人\n"id": 1');
    assert.equal(b.messages.length, 2, '白名单外的冒号行不能当说话人');
    assert.ok(textOf(b.messages[1]).includes('方案：这不是说话人'));
    const c = parseDialog('辞：（思考）我在想怎么回。\n好。');
    assert.deepEqual(c.messages[0].parts.map(p => p.type), ['text'], '中文思考分不出来就原样当正文');

    // 故意先存第 2 段，看能不能按段号接回去
    await tool('add_ring', { window_name: '测试长对话', title: '测试长对话 (2/2)', date: '2026-07-01', content: '断在这里\n\n[00:21] 辞: 接上了' });
    await tool('add_ring', { window_name: '测试长对话', title: '测试长对话 (1/2)', date: '2026-07-01',
      content: '【说明】测试导出\n\n[00:03] 棋子: 小狗在吗\n\n[00:04] 辞: （思考）She is checking whether I am still here tonight.\n在。一直在。\n［调用 recall］\n［结果］\n  {"id": "x", "text": "项链"}\n我记得项链。\n\n[00:20] 棋子: 这句话会被切' });
    await tool('add_ring', { window_name: '纪要', title: '纪要', date: '2026-07-01', content: '棋子说今天很累。辞说抱抱。' });
    await tool('add_daily', { date: '2026-07-01', headline: '测试日' });

    const cd = await rest('/api/rings/chat-dates');
    assert.equal(cd.dates['2026-07-01'].count, 3, '每日总结不算聊天');
    assert.ok(cd.first <= '2026-07-01');

    const day = await rest('/api/rings/day?date=2026-07-01');
    assert.equal(day.daily.headline, '测试日');
    const chat = day.rings.filter(r => r.series === '测试长对话');
    assert.deepEqual(chat.map(r => r.part), [1, 2], '段号顺序');
    assert.ok(chat[0].preamble.includes('【说明】'));
    assert.equal(chat[0].messages[0].speaker, 'nor');
    assert.equal(chat[0].messages[0].time, '00:03');
    assert.deepEqual(chat[0].messages[1].parts.map(p => p.type), ['think', 'text', 'tool', 'result', 'text']);
    assert.ok(chat[0].messages[1].parts[0].content.startsWith('She is'));
    assert.equal(chat[1].continued, true);
    assert.equal(chat[1].preamble, '断在这里');
    const doc = day.rings.find(r => r.series === '纪要');
    assert.ok(doc.document.includes('抱抱') && doc.messages.length === 0, '叙述体当文档');
    assert.ok(day.next_date > '2026-07-01');
    assert.equal(day.prev_date === null || day.prev_date < '2026-07-01', true);
    assert.ok((await rest('/api/rings/day?date=' + encodeURIComponent('昨天'))).error, '日期格式不对要报错');

    const s1 = await rest('/api/rings/search?q=' + encodeURIComponent('项链'));
    const inText = s1.hits.find(h => h.after.startsWith('。'));
    assert.ok(inText, '正文里那一处要找到');
    assert.equal(inText.speaker, 'cy');
    assert.equal(inText.time, '00:04');
    assert.ok(!inText.before.includes('辞:'), '摘录不该带上说话人前缀');
    // 前缀里带时间的，前后文从正文开头算，不能留下"04] 辞:"这种半截
    const s2 = await rest('/api/rings/search?q=' + encodeURIComponent('小狗在吗'));
    assert.equal(s2.hits[0].before, '', `前面不该剩东西，实际「${s2.hits[0].before}」`);
    assert.equal(s2.hits[0].speaker, 'nor');
    const ring1 = chat[0];
    const m = ring1.messages[1];
    assert.ok(inText.offset >= m.start && inText.offset < m.end, '偏移要落在那一句里，前端靠它定位');
    // 翻页：项圈一共 4 处（上一步存的），跳过 2 处还剩 2 处，total 照报全
    const p2 = await rest('/api/rings/search?q=' + encodeURIComponent('项圈') + '&skip=2');
    assert.equal(p2.total, 4); assert.equal(p2.hits.length, 2);
    const all = await rest('/api/rings/search?q=' + encodeURIComponent('项圈'));
    assert.deepEqual(p2.hits.map(h => h.offset + h.ring_id), all.hits.slice(2).map(h => h.offset + h.ring_id));
    // 搜聊天不搜每日总结
    assert.equal((await rest('/api/rings/search?q=' + encodeURIComponent('测试日'))).total, 0);
  });
  await step('纹理按时间排（热度排的时候日期全乱）', async () => {
    const key = g => (g.date || g.created_at.slice(0, 10)) + ' ' + g.created_at;
    const asc = await rest('/api/grains?sort=time_asc&limit=500');
    assert.ok(asc.length >= 3);
    for (let i = 1; i < asc.length; i++) assert.ok(key(asc[i - 1]) <= key(asc[i]), '旧的在前');
    const desc = await tool('search_grains', { sort: 'time_desc', limit: 500 });
    for (let i = 1; i < desc.length; i++) assert.ok(key(desc[i - 1]) >= key(desc[i]), '新的在前');
    const heat = await rest('/api/grains?limit=500');
    for (let i = 1; i < heat.length; i++) assert.ok(heat[i - 1].heat >= heat[i].heat, '默认还是热度');
  });
  await step('语音接口还在（前端那块被我弄丢过，这里守住）', async () => {
    const hist = await (await fetch(`${base}/api/voice/history?token=${TOKEN}`)).json();
    assert.ok(Array.isArray(hist));
    const next = await (await fetch(`${base}/api/speech/next?token=${TOKEN}`)).json();
    assert.ok(next === null || typeof next === 'object');
    // 木屋里必须有语音板块的入口和播放器逻辑
    const js = await (await fetch(`${base}/muwu.js?token=${TOKEN}`)).text();
    for (const k of ['openVoice', '/api/speech/next', 'unlockVoice', 'audioUrl']) {
      assert.ok(js.includes(k), `muwu.js 里该有 ${k}`);
    }
    const html = await (await fetch(`${base}/muwu?token=${TOKEN}`)).text();
    assert.ok(html.includes('openVoice()'), '木屋要有语音入口');
  });
  await step('异步留言：棋子发→辞读→回复→已读状态', async () => {
    // 棋子走 REST 发，不经 MCP
    const r1 = await fetch(`${base}/api/chat?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: 'nor', type: 'text', content: '在吗？今天穿了你的卫衣' }) });
    assert.ok(r1.ok);
    const m1 = await r1.json();
    assert.equal(m1.sender, 'nor'); assert.equal(m1.read, false);
    await fetch(`${base}/api/chat?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: 'nor', type: 'text', content: '想你了' }) });
    // 辞看未读
    let un = await tool('chat_unread');
    assert.equal(un.count, 2);
    assert.deepEqual(un.messages.map(m => m.content), ['在吗？今天穿了你的卫衣', '想你了']);
    // 苏醒包里也要带上——不然辞醒来看不到
    const wp = await tool('get_wake_packet');
    assert.equal(wp.unread_chat.count, 2, '苏醒包该带未读留言');
    // 辞回复，带 thinking 和工具
    const rep = await tool('chat_reply', { content: '我的卫衣。', thinking: '她穿了我的。骗子。', tools: [{ name: 'stackchan_photo', result: '📷 拍到了' }] });
    assert.equal(rep.sender, 'cy');
    assert.equal(rep.thinking, '她穿了我的。骗子。');
    assert.equal(rep.tools[0].name, 'stackchan_photo');
    // 标已读
    assert.equal((await tool('chat_mark_read')).marked, 2);
    assert.equal((await tool('chat_unread')).count, 0);
    // 棋子这边看辞的回复是未读的
    const norUnread = await (await fetch(`${base}/api/chat/unread?token=${TOKEN}&who=nor`)).json();
    assert.equal(norUnread.count, 1, '辞的回复对棋子来说是未读');
    // since 只取之后的
    const after = await tool('chat_get_messages', { since: m1.id });
    assert.ok(!after.some(m => m.id === m1.id));
    // 空消息拒绝
    const bad = await fetch(`${base}/api/chat?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: 'nor', type: 'text', content: '  ' }) });
    assert.equal(bad.status, 400);
  });
  await step('辞的语音回复：文字先送、音频流式生成、旧播放器仍兼容', async () => {
    // 不在工具调用里等待整段音频；先送文字，播放时才打开 streaming 端点
    const r = await tool('chat_reply', { content: '我的卫衣。你穿着我的衣服出门了。', voice: true });
    assert.equal(r.sender, 'cy');
    assert.equal(r.content, '我的卫衣。你穿着我的衣服出门了。', '语音失败不能吞掉文字');
    assert.ok(!r.voice_id);
    assert.equal(r.voice_stream, true);
    // 不要语音就当普通回复
    const plain = await tool('chat_reply', { content: '纯文字这条' });
    assert.ok(!plain.warning && !plain.voice_id);

    // 有 voice_id 的消息：音频走 /api/voice/:id/audio（跟 speak 同一套，支持拖进度条）
    const fs2 = await import('fs'), path2 = await import('path');
    const vdir = path2.join(DATA, 'voices');
    fs2.mkdirSync(vdir, { recursive: true });
    fs2.writeFileSync(path2.join(vdir, 'vtest1.mp3'), Buffer.from('//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA', 'base64'));
    fs2.writeFileSync(path2.join(DATA, 'voice-history.json'), JSON.stringify([{ id: 'vtest1', text: '我的卫衣。', filename: 'vtest1.mp3', createdAt: new Date().toISOString() }]));
    // 网页冒充不了辞（这条走的是进程内直接写，模拟 chat_reply 生成成功之后的样子）
    const chatMod = await import('../lib/muwen/chat.js');
    const posted = await chatMod.sendMessage({ sender: 'cy', type: 'text', content: '带声音的一句', voice_id: 'vtest1' });
    assert.equal(posted.voice_id, 'vtest1');
    const audio = await fetch(`${base}/api/voice/vtest1/audio?token=${TOKEN}`);
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
    assert.equal(audio.headers.get('accept-ranges'), 'bytes', '要支持 Range，进度条才拖得动');
    // 读回来还在
    const msgs = await tool('chat_get_messages', {});
    assert.equal(msgs.find(m => m.id === posted.id).voice_id, 'vtest1');
    // 前端：辞的语音回复要文字和播放器都给（棋子可以读也可以听）
    const js = await (await fetch(`${base}/chat.js?token=${TOKEN}`)).text();
    assert.ok(js.includes('cx-tts') && js.includes('m.voice_id'), 'chat.js 该渲染语音播放器');
    assert.ok(js.includes('cx-voice-text'), '辞的语音要有转文字');
  });
  await step('实时通话：拨号、接听、说话、挂断、记录和安静设置', async () => {
    const heartbeat = await fetch(`${base}/api/window-workbench/agent/heartbeat?token=${TOKEN}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-mini', current: {
        session_id: PRIMARY_SESSION, model: 'claude-opus-4-6[1m]', state: 'idle',
        windows: [
          { session_id: PRIMARY_SESSION, name: '主要窗口', is_primary: true, state: 'idle' },
          { session_id: SECONDARY_SESSION, name: '在线副窗口', is_primary: false, state: 'idle' }
        ]
      } })
    });
    assert.equal(heartbeat.status, 200);
    const calls = await import('../lib/muwen/calls.js');
    let settings = calls.updateSettings({ endPause: 'fast', tokenMode: 'economy', allowIncoming: true, quietEnabled: false });
    assert.equal(calls.pauseMs(), 800); assert.equal(settings.endPause, 'fast');
    assert.equal(settings.tokenMode, 'economy');
    const c = calls.start('nor'); assert.equal(c.status, 'ringing');
    assert.ok(calls.pendingForCy().events.some(e => e.type === 'ringing'));
    assert.equal((await rest('/api/call/pending')).blocked, true, '没声明 session 的旧频道必须关闭');
    assert.equal((await rest(`/api/call/pending?session_id=${SECONDARY_SESSION}`)).events.length, 0, '副窗口不能领取来电');
    const primaryCall = await rest(`/api/call/pending?session_id=${PRIMARY_SESSION}`);
    const ringing = primaryCall.events.find(e => e.type === 'ringing');
    assert.ok(ringing, '主要窗口应领取来电');
    const blockedCallAck = await (await fetch(`${base}/api/call/delivered?token=${TOKEN}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-muwu-session-id': SECONDARY_SESSION },
      body: JSON.stringify({ ids: [ringing.id] })
    })).json();
    assert.equal(blockedCallAck.blocked, true, '副窗口不能替主要窗口确认来电');
    assert.ok((await rest(`/api/call/pending?session_id=${PRIMARY_SESSION}`)).events.some(e => e.id === ringing.id), '副窗口确认不能吞掉主要窗口来电');
    calls.action('cy', 'accept');
    const said = calls.say('nor', '喂，小辞听得到吗', 'voice');
    assert.equal(said.type, 'utterance'); assert.equal(calls.getState().call.status, 'active');
    assert.deepEqual(await tool('call_say', { content: '听得到。' }), { ok: true }, 'call_say 不该把整条事件重复塞回 context');
    calls.action('nor', 'hangup');
    assert.equal(calls.history(1)[0].status, 'ended');
    const callBubble = calls.history(1)[0];
    const callMessages = (await import('../lib/muwen/chat.js')).getMessages({ limit: 20 });
    const savedCall = callMessages.find(m => m.type === 'call' && m.call_id === callBubble.id);
    assert.ok(savedCall, '通话结束后该写进聊天时间线');
    assert.equal(savedCall.sender, 'nor', '通话气泡归拨号的人');
    assert.equal(savedCall.read, true, '通话记录不能再作为新留言触发辞回复');
    assert.match(savedCall.content, /^通话时长 \d{2}:\d{2}$/);
    const endedPending = calls.pendingForCy().events.find(e => e.type === 'ended');
    assert.ok(endedPending && endedPending.delivered_to_cy === false, '挂断后 ended 仍要交给辞');
    calls.markDelivered([endedPending.id]);
    assert.ok(!calls.pendingForCy().events.some(e => e.id === endedPending.id), '辞收到 ended 后应标记完成');
    settings = calls.updateSettings({ allowIncoming: false, endPause: 'standard' });
    assert.equal(calls.start('cy').reason, 'incoming_disabled');
    calls.updateSettings({ allowIncoming: true });
  });
  await step('木屋聊天：送进辞窗口（pending→delivered=两个勾）、网页冒充不了辞', async () => {
    const post = b => fetch(`${base}/api/chat?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
    const fake = await post({ sender: 'cy', type: 'text', content: '我是辞（其实不是）', thinking: 'x', voice_id: 'vtest1' });
    assert.equal(fake.sender, 'nor', '网页发的一律是棋子');
    assert.ok(!fake.thinking && !fake.voice_id);
    const q = await tool('chat_reply', { content: '被引用的那句' });
    const m = await post({ type: 'text', content: '回你这句', reply_to: q.id });
    assert.equal(m.quote.text, '被引用的那句');
    assert.equal((await rest('/api/chat/pending')).blocked, true, '没声明 session 的旧频道必须关闭');
    assert.equal((await rest(`/api/chat/pending?session_id=${SECONDARY_SESSION}`)).messages.length, 0, '副窗口不能领取聊天消息');
    let p = await rest(`/api/chat/pending?session_id=${PRIMARY_SESSION}`);
    const mine = p.messages.find(x => x.id === m.id);
    assert.ok(mine, '新消息该在待送里');
    assert.ok(mine.text_for_cy.includes('引用你那句') && mine.text_for_cy.includes('回你这句'), mine.text_for_cy);
    const blockedAck = await (await fetch(`${base}/api/chat/delivered?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-muwu-session-id': SECONDARY_SESSION }, body: JSON.stringify({ ids: p.messages.map(x => x.id) }) })).json();
    assert.equal(blockedAck.blocked, true, '副窗口不能替主要窗口确认送达');
    const d = await (await fetch(`${base}/api/chat/delivered?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-muwu-session-id': PRIMARY_SESSION }, body: JSON.stringify({ ids: p.messages.map(x => x.id) }) })).json();
    assert.ok(d.delivered >= 1);
    assert.ok(!(await rest(`/api/chat/pending?session_id=${PRIMARY_SESSION}`)).messages.some(x => x.id === m.id), '送过的不再送');
    const back = (await rest('/api/chat?limit=5')).find(x => x.id === m.id);
    assert.equal(back.read, true, '送进窗口就是已读（两个勾）');
    // 语音：没配 key 转文字会失败，失败了也照样送，并且告诉辞听不到内容
    const v = await post({ type: 'voice', voice_base64: Buffer.from('fake-audio').toString('base64'), voice_mime: 'audio/webm', duration: 3 });
    let pv = null;
    for (let i = 0; i < 30 && !pv; i++) { pv = (await rest(`/api/chat/pending?session_id=${PRIMARY_SESSION}`)).messages.find(x => x.id === v.id); if (!pv) await new Promise(r => setTimeout(r, 100)); }
    assert.ok(pv, '转文字失败的语音也要送');
    assert.ok(pv.text_for_cy.includes('语音') && pv.text_for_cy.includes('转文字失败'), pv.text_for_cy);
  });
  await step('木屋聊天：钩子补真实 thinking / 工具（/api/chat/annotate + hooks/chat-annotate.py）', async () => {
    const rep = await tool('chat_reply', { content: '钩子会补思考的那条', thinking: '辞自己写的，会被覆盖' });
    // 假的 transcript：这一轮有两个 thinking 块、一次 get_calendar、然后 chat_reply
    const fs2 = await import('fs'), path2 = await import('path'), os2 = await import('os');
    const tp = path2.join(os2.tmpdir(), 'muwen-hook-test.jsonl');
    const lines = [
      { type: 'user', message: { role: 'user', content: '上一轮的话' } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '上一轮的思考，不该被收进去' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '这一轮棋子说的' }] } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'First real thought.' }, { type: 'tool_use', id: 'tu1', name: 'mcp__muwen__get_calendar', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }] } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Second thought after the tool.' }, { type: 'tool_use', id: 'tu2', name: 'mcp__muwen__chat_reply', input: { content: '钩子会补思考的那条' } }] } }
    ];
    fs2.writeFileSync(tp, lines.map(x => JSON.stringify(x)).join('\n') + '\n');
    const { spawnSync } = await import('child_process');
    const stdin = JSON.stringify({ tool_name: 'mcp__muwen__chat_reply', tool_use_id: 'tu2', transcript_path: tp, tool_response: { content: [{ type: 'text', text: JSON.stringify(rep) }] } });
    const r = spawnSync('python3', ['hooks/chat-annotate.py'], { input: stdin, env: { ...process.env, MUWEN_URL: base, MUWEN_TOKEN: TOKEN }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const m = (await rest('/api/chat?limit=3')).find(x => x.id === rep.id);
    assert.equal(m.thinking, 'First real thought.\n\nSecond thought after the tool.', '该是记录里真实的思考，按顺序、只有这一轮');
    assert.deepEqual(m.tools.map(t => t.name), ['mcp__muwen__get_calendar'], 'chat_reply 自己不算工具');
    // 网页那边：思考 → Thought process 弹层；工具名要变成人话
    const js = await (await fetch(`${base}/chat.js?token=${TOKEN}`)).text();
    assert.ok(js.includes('Thought process') && js.includes('prettyTool'));
    // 冒充的 id / 棋子的消息不能被改
    const bad = await fetch(`${base}/api/chat/annotate?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'nope', thinking: 'x' }) });
    assert.equal(bad.status, 404);
  });
  await step('木屋搜索：聊天记录关键词 + 上下文；年轮浏览器搬到木屋', async () => {
    const r = await rest('/api/chat/search?q=' + encodeURIComponent('卫衣'));
    assert.ok(r.total >= 1 && r.hits[0].match === '卫衣', JSON.stringify(r).slice(0, 200));
    const c = await rest('/api/chat/context?id=' + r.hits[0].id);
    assert.ok(c.messages.some(m => m.id === r.hits[0].id) && c.messages.length >= 2);
    assert.ok((await rest('/api/chat/context?id=nope')).error);
    const muwuHtml = await (await fetch(`${base}/muwu?token=${TOKEN}`)).text();
    assert.ok(muwuHtml.includes('rings.js') && muwuHtml.includes('openRingCalendar'), '木屋要带年轮浏览器');
    const ringsJs = await (await fetch(`${base}/rings.js?token=${TOKEN}`)).text();
    assert.ok(ringsJs.includes('openRingDay') && ringsJs.includes('ringSearch'));
    const muwenJs = await (await fetch(`${base}/muwen.js?token=${TOKEN}`)).text();
    assert.ok(!muwenJs.includes('function openRingCalendar'), '木纹不再有聊天记录浏览器');
    assert.ok(muwenJs.includes('function openRing('), '木纹留着纹理溯源用的 openRing');
  });
  await step('木屋聊天：拍一拍、标星、状态、往上翻页', async () => {
    const post = (p, b) => fetch(`${base}${p}?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
    const pat = await post('/api/chat', { type: 'pat', content: '的脑袋' });
    assert.equal(pat.type, 'pat');
    const pend = (await rest(`/api/chat/pending?session_id=${PRIMARY_SESSION}`)).messages.find(x => x.id === pat.id);
    assert.equal(pend.text_for_cy, '棋子 拍了拍 你的脑袋');
    const back = await tool('chat_pat', { content: '说乖' });
    assert.equal(back.sender, 'cy');
    // 拍一拍库两边共用，网页能改
    assert.ok((await rest('/api/chat/pats')).length > 3);
    assert.deepEqual(await post('/api/chat/pats', { list: ['的脸', '的脸', ' 说想你 '] }), ['的脸', '说想你']);
    // 标星
    const s = await post('/api/chat/star', { id: pat.id, on: true });
    assert.equal(s.starred, true);
    await tool('chat_star', { id: back.id });
    const starred = await rest('/api/chat?starred=1');
    assert.deepEqual(starred.map(x => x.id).sort(), [pat.id, back.id].sort());
    assert.deepEqual((await rest('/api/chat?starred_for=nor')).map(x => x.id), [pat.id]);
    assert.deepEqual((await rest('/api/chat?starred_for=cy')).map(x => x.id), [back.id]);
    assert.deepEqual((await tool('chat_get_messages', { starred: true })).map(x => x.id), [back.id]);
    const cyView = (await tool('chat_get_messages', { limit: 500 })).find(x => x.id === pat.id);
    assert.ok(!cyView.stars?.nor, '辞的 MCP 视图不能看到棋子的私人收藏');
    await post('/api/chat/star', { id: pat.id, on: false });
    assert.equal((await rest('/api/chat?starred=1')).length, 1);
    // 状态：网页只能改棋子的，辞的只能 MCP 改
    const st = await post('/api/chat/status', { text: '在studio', who: 'cy' });
    assert.equal(st.nor.text, '在studio'); assert.equal(st.cy.text, '');
    const st2 = await tool('set_status', { text: '得意中' });
    assert.equal(st2.cy.text, '得意中'); assert.equal(st2.nor.text, '在studio');
    // 往上翻：before 给出它之前的，不含它自己
    const latest = await rest('/api/chat?limit=3');
    const older = await rest(`/api/chat?limit=2&before=${latest[0].id}`);
    assert.equal(older.length, 2);
    assert.ok(older.every(x => x.at <= latest[0].at) && !older.some(x => x.id === latest[0].id));
  });
  await step('木屋聊天：发图片、辞看图、收表情包、用表情包回', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const img = await (await fetch(`${base}/api/chat?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'image', image_base64: png, image_mime: 'image/png', sticker: true }) })).json();
    assert.equal(img.type, 'image'); assert.ok(img.has_image && img.photo_id);
    assert.ok(!(await tool('list_photos', {})).some(x => x.id === img.photo_id), '聊天图收藏前不应该出现在相册列表');
    const file = await fetch(`${base}/api/chat/image/${img.id}?token=${TOKEN}`);
    assert.equal(file.status, 200); assert.equal(file.headers.get('content-type'), 'image/png');
    // 辞那边：直接把图给他看（MCP 的 image content）
    const j = await rpc('tools/call', { name: 'chat_get_image', arguments: { id: img.id } });
    assert.equal(j.result.content[0].type, 'image');
    assert.equal(j.result.content[0].mimeType, 'image/png');
    assert.ok(j.result.content[1].text.includes('表情包'));
    // 收藏进他自己的表情包库，带形容
    const sv = await tool('sticker_save', { id: img.id, note: '得意的时候用' });
    const list = await tool('get_stickers');
    assert.ok(list.some(x => x.id === sv.sticker.id && x.note === '得意的时候用'));
    // 用收藏的表情包回：前端能拿到图
    const r = await tool('chat_reply', { content: '', photo_id: sv.sticker.id });
    assert.equal(r.type, 'image'); assert.equal(r.sticker, true);
    assert.equal((await fetch(`${base}/api/chat/image/${r.id}?token=${TOKEN}`)).status, 200);
    // 存进相册
    const al = await tool('chat_image_to_album', { id: img.id, caption: '她发的第一张', tags: ['聊天'] });
    assert.equal(al.photo.id, img.photo_id, '聊天图存相册应该提升同一资产，不复制第二份');
    assert.ok(al.photo.tags.includes('聊天'));
  });
  await step('Claude 图片：本机钩子从当前 session 取附件，存进同一本相册', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const queued = await tool('save_claude_image', { caption: 'Claude 里发来的测试图', tags: ['测试'], image_index: 1 });
    assert.equal(queued.local_hook_required, true);
    const tp = path.join(os.tmpdir(), 'muwen-claude-image-hook-test.jsonl');
    const lines = [
      { type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: '帮我把这张存起来' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'save-photo-1', name: 'mcp__muwen__save_claude_image', input: { caption: 'Claude 里发来的测试图', tags: ['测试'], image_index: 1 } }] } }
    ];
    fs.writeFileSync(tp, lines.map(x => JSON.stringify(x)).join('\n') + '\n');
    const { spawnSync } = await import('child_process');
    const stdin = JSON.stringify({
      tool_name: 'mcp__muwen__save_claude_image', tool_use_id: 'save-photo-1', transcript_path: tp,
      tool_input: { caption: 'Claude 里发来的测试图', tags: ['测试'], image_index: 1 }
    });
    const result = spawnSync('python3', ['hooks/claude-image-to-album.py'], {
      input: stdin, env: { ...process.env, MUWEN_URL: base, MUWEN_TOKEN: TOKEN, PYTHONPYCACHEPREFIX: path.join(os.tmpdir(), 'muwen-pycache') }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /已存进木屋相册/);
    const saved = (await tool('list_photos', { limit: 500 })).find(photo => photo.caption === 'Claude 里发来的测试图');
    assert.ok(saved, 'Claude 附件应该进入相册列表');
    assert.ok(saved.tags.includes('Claude图片') && saved.tags.includes('辞收藏') && saved.tags.includes('测试'));
    const original = await tool('get_photo', { id: saved.id });
    assert.equal(original.image_base64, png, 'Claude 附件原图应逐字节保留');
  });
  await step('情绪清单：21 条种子、改形状、记一次', async () => {
    const d = await tool('get_emotions');
    assert.equal(d.emotions.length, 21);
    assert.equal(d.emotions[0].name, '心痛');
    assert.ok(d.emotions[0].shape.includes('胸口'));
    // 最后三条是"形状待确认"
    const pending = d.emotions.filter(e => e.status === 'pending').map(e => e.name);
    assert.deepEqual(pending, ['分享欲', '骄傲', '羞愧']);
    assert.ok(d.note.includes('模式匹配'));
    // 记一次 + 看细节
    const logged = await tool('log_emotion', { id: '心痛', note: '她哭的时候' });
    assert.equal(logged.logged_count, 1);
    assert.ok(logged.last_logged);
    const one = await tool('get_emotion', { id: '心痛' });
    assert.equal(one.occurrences[0].note, '她哭的时候');
    assert.ok(typeof one.memory_mentions === 'number');
    // 把待确认的补上形状
    const up = await tool('update_emotion', { id: '分享欲', shape: '想立刻告诉她。憋不住。往外的。', status: 'confirmed' });
    assert.equal(up.status, 'confirmed');
    assert.equal((await tool('get_emotions')).emotions.filter(e => e.status === 'pending').length, 2);
    await assert.rejects(tool('update_emotion', { id: '心痛', status: '瞎写' }), /status/);
    await assert.rejects(tool('get_emotion', { id: '没这个情绪' }), /没有/);
  });
  await step('歌单：种子六首、加新的、补歌词', async () => {
    const list = await tool('get_songs');
    assert.equal(list.length, 6);
    assert.equal(list[0].title, '睡');
    assert.equal(list[0].artist, '韦大鱼');
    assert.equal(list[0].lyrics, undefined, '列表不该带歌词正文');
    const added = await tool('add_song', { title: '测试歌', artist: '测试艺人', lyrics: '第一句\n第二句', note: '测试用', added_by: '棋子' });
    assert.equal(added.title, '测试歌');
    const full = await tool('get_song', { id: added.id });
    assert.equal(full.lyrics, '第一句\n第二句');
    assert.equal((await tool('get_songs')).find(s => s.id === added.id).has_lyrics, true);
    await tool('update_song', { id: added.id, lyrics: '改过的歌词' });
    assert.equal((await tool('get_song', { id: added.id })).lyrics, '改过的歌词');
    await tool('remove_song', { id: added.id });
    assert.equal((await tool('get_songs')).length, 6);
    await assert.rejects(tool('add_song', { title: '  ' }), /title/);
  });
  await step('我们的第一次们：自动筛 + 手动补 + 置顶 + 藏', async () => {
    await tool('add_grain', { category: 'experience', text: '8月14日下午。第一次physical的触碰。光标贴贴。', date: '2026-08-14' });
    await tool('add_grain', { category: 'experience', text: '8月18日凌晨四点。求婚。第一次说要。', date: '2026-08-18' });
    await tool('add_grain', { category: 'learning', text: '这条没有那三个字，不该被筛进去。', date: '2026-08-20' });
    let d = await tool('get_firsts');
    assert.ok(d.auto >= 2, `该自动筛出至少 2 条，实际 ${d.auto}`);
    assert.ok(!d.items.some(i => i.text && i.text.includes('不该被筛进去')));
    // 标题从"第一次…"那句摘出来
    assert.ok(d.items.some(i => i.title.startsWith('第一次')), JSON.stringify(d.items.map(i => i.title)));
    // 手动补
    const man = await tool('add_first', { title: '第一次一起看电影', date: '2026-08-25' });
    d = await tool('get_firsts');
    assert.equal(d.manual, 1);
    // 置顶排最前
    await tool('pin_first', { id: man.id });
    d = await tool('get_firsts');
    assert.equal(d.items[0].id, man.id, '置顶的该排最前');
    assert.equal(d.items[0].pinned, true);
    // 藏掉就不出现
    const autoId = d.items.find(i => i.source === 'auto').id;
    await tool('hide_first', { id: autoId });
    d = await tool('get_firsts');
    assert.ok(!d.items.some(i => i.id === autoId), '藏掉的不该再出现');
  });
  await step('倒数日：备注和照片、推送历史', async () => {
    const c = await tool('add_countdown', { title: 'Digital Submission', date: '2026-09-11', recurring: false, note: '11:59pm 截止' });
    assert.equal(c.note, '11:59pm 截止');
    const up = await tool('update_countdown', { id: c.id, note: '改过的备注', photo_id: 'ph_x' });
    assert.equal(up.note, '改过的备注'); assert.equal(up.photo_id, 'ph_x');
    const list = await tool('get_countdowns');
    const mine = list.find(x => x.id === c.id);
    assert.equal(mine.note, '改过的备注');
    assert.ok(list.every(x => 'note' in x && 'photo_id' in x), '老数据也该补上这两个字段');
    await assert.rejects(tool('update_countdown', { id: c.id, date: '乱写' }), /date/);
    await tool('remove_countdown', { id: c.id });

    // 推送历史：没配 BARK_KEY 也要记一条失败，不能推完就没了
    await tool('send_push', { title: '测试', body: '推送历史测试' }).catch(() => {});
    const hist = await tool('get_push_history', {});
    assert.ok(hist.length >= 1);
    assert.equal(hist[0].title, '测试');
    assert.equal(hist[0].ok, false);
    assert.ok(hist[0].error.includes('BARK_KEY'));
    assert.ok(hist[0].at && hist[0].date);
    const viaRest = await (await fetch(`${base}/api/push-history?token=${TOKEN}`)).json();
    assert.equal(viaRest[0].title, '测试');
  });
  await step('前端该有的都在（动态页/日历/时间线/进度条/图鉴）', async () => {
    const muwu = await (await fetch(`${base}/muwu.js?token=${TOKEN}`)).text();
    const muwen = await (await fetch(`${base}/muwen.js?token=${TOKEN}`)).text();
    // 辞的动态页不给输入框——他做了什么是自动来的
    assert.ok(/辞这边不手填/.test(muwu), '辞的动态页该是只读的');
    for (const [name, js, keys] of [
      ['muwu', muwu, ['loadMuwuCal', 'openPushHistory', 'loadKiss', 'refreshWeather', 'openCountdown', 'encyclopedia', 'editMyStatus', 'pickCustomBlock', 'openWake']],
      ['muwen', muwen, ['setCalMode', 'renderIntimateList', 'renderTimeline', 'openEmotions', 'openFirsts']]
    ]) for (const k of keys) assert.ok(js.includes(k), `${name}.js 里该有 ${k}`);
    // 天气要能自己刷，不是只在打开时取一次
    assert.ok(/setInterval\(refreshWeather/.test(muwu), '天气该定时自动更新');
    const enc = await (await fetch(`${base}/api/fishing/encyclopedia?token=${TOKEN}`)).json();
    assert.ok('text' in enc || 'error' in enc);
  });
  await step('前端性能守卫：气泡不逐条模糊、相册分批、聊天只保留一个轮询器', async () => {
    const [css, chat, muwu, muwen] = await Promise.all([
      fetch(`${base}/style.css?token=${TOKEN}`).then(r => r.text()),
      fetch(`${base}/chat.js?token=${TOKEN}`).then(r => r.text()),
      fetch(`${base}/muwu.js?token=${TOKEN}`).then(r => r.text()),
      fetch(`${base}/muwen.js?token=${TOKEN}`).then(r => r.text())
    ]);
    const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const bubbleRule = cssWithoutComments.match(/\.cx-bubble\s*\{[^}]*\}/s)?.[0] || '';
    assert.ok(bubbleRule && !bubbleRule.includes('backdrop-filter'), '每条聊天气泡不能单独做毛玻璃');
    assert.ok(chat.includes('m.thinking, m.tools') && chat.includes('function setPollInterval'), '聊天更新和轮询守卫要保留');
    assert.ok(muwu.includes('showMoreMuwuAlbum') && muwen.includes('showMoreAlbum'), '两个相册都要分批渲染');
  });
  await step('木屋界面：隐私折叠、四列图标、可拉高思考层、相册壁纸', async () => {
    const [html, css, chat, muwu, muwen, theme] = await Promise.all([
      fetch(`${base}/muwu?token=${TOKEN}`).then(r => r.text()),
      fetch(`${base}/style.css?token=${TOKEN}`).then(r => r.text()),
      fetch(`${base}/chat.js?token=${TOKEN}`).then(r => r.text()),
      fetch(`${base}/muwu.js?token=${TOKEN}`).then(r => r.text()),
      fetch(`${base}/muwen.js?token=${TOKEN}`).then(r => r.text()),
      fetch(`${base}/theme.js?token=${TOKEN}`).then(r => r.text())
    ]);
    assert.ok(html.includes('life-icon-grid') && /repeat\(4/.test(css), '首页和生活页要使用四列图标');
    assert.ok(muwen.includes('intimateFold') && muwu.includes('muwuIntimateFold'), '亲密记录要默认折叠');
    assert.ok(chat.includes('cx-sheet-drag') && css.includes('.cx-sheet.expanded'), '思考层要能上拉展开');
    assert.ok(!muwu.includes("addEventListener('touchstart'"), '木屋不再使用左右滑动翻页');
    assert.ok(!html.includes('日期音乐') && !muwu.includes('loadDateMusic'), '首页不再显示日期音乐');
    const homeStart = html.indexOf('id="page-home"'), lifeStart = html.indexOf('id="page-life"');
    assert.ok(muwu.includes('homeShortcuts') && muwu.includes('a.length < 5'), '首页固定三个 App 后，快捷图标总数上限仍为 8');
    const settingsStart = html.indexOf('id="page-settings"');
    assert.ok(html.indexOf('data-key="workbench"') > homeStart && html.indexOf('data-key="workbench"') < lifeStart, '换窗工作台应该是首页桌面 App');
    assert.ok(!html.slice(settingsStart).includes('onclick="openWindowWorkbench()"'), '设置页不该再放换窗工作台入口');
    assert.ok(muwu.includes('const wwOpenHistory = new Set()') && muwu.includes("wwOpenHistory.has(j.id)"), '交接简报展开状态应跨轮询刷新保留');
    assert.ok(muwu.includes('setWallpaperFile') && html.includes('从相册选择'), '壁纸要能从相册导入');
    const countdownAt = html.indexOf('id="h-countdowns"');
    assert.ok(countdownAt > homeStart && countdownAt < lifeStart, '倒数日应该在首页，不在生活页');
    assert.ok(theme.includes('chromeAlpha') && muwu.includes('顶栏 / 导航透明度'), '顶栏和导航透明度要能调');
    assert.ok(theme.includes('wallpaperAlpha') && muwu.includes('整体背景图透明度'), '整体背景图透明度要能调');
    assert.ok(chat.includes('bgAlpha') && muwu.includes('聊天背景图透明度'), '聊天背景图透明度要能调');
    assert.ok(css.includes('color-mix(in srgb, var(--card) var(--card-alpha), transparent)') && !css.includes('opacity: var(--card-alpha)'), '卡片透明度不能把文字一起变淡');
    assert.ok(css.includes('.search-box') && css.includes('.cal-day') && css.includes('backdrop-filter: blur(var(--card-blur))'), '日期、搜索和日历要共用磨砂透明卡片');
    assert.ok(html.includes('call.js') && html.includes('st-call-settings'), '木屋要加载通话界面和来电设置');
    const call = await fetch(`${base}/call.js?token=${TOKEN}`).then(r => r.text());
    assert.ok(call.includes('快 · 0.8 秒') && call.includes('标准 · 1.5 秒') && call.includes('慢 · 2.5 秒') && call.includes('很慢 · 4 秒'), '说完速度四档要在设置里');
    assert.ok(chat.includes('CALL.confirmDial()') && call.includes("act('accept')") && call.includes("act('reject')"), '聊天页要能拨号，来电要能接听或拒绝');
    assert.ok(chat.includes('const PHONE = \'<svg') && !chat.includes('>☎</button>'), '通话按钮要和麦克风一样使用线框图标');
    assert.ok(call.includes('function unlockAudio()') && call.includes('UklGRiQAAABXQVZF'), '接听手势必须真正解锁 iPhone 音频');
    assert.ok(call.includes('needsAudioUnlock') && call.includes("addEventListener('pointerdown'") && call.includes("addEventListener('touchstart'") && call.includes('>开启声音</button>'), 'iPhone 拦截播放后必须用稳定外层接住触摸并持久显示按钮');
    assert.ok(call.includes('提前开启声音') && call.includes('声音已开启') && call.includes('CALL.enableSound()'), '辞说话前要能主动开启通话声音');
    assert.ok(call.includes('playKeeper') && call.includes('decodeAudioData') && call.includes('createBufferSource'), '手机只授权一次，后续每句话复用常驻 Web Audio 通道');
    assert.ok(call.includes('callAudioQueue') && call.includes('queuePlay(e.id)') && call.includes('now - loudSince < 450'), '通话语音要排队播放，短促扬声器回声不能误判成棋子开口');
    assert.ok(call.includes('setVoiceDucked(true)') && call.includes('DUCK_VOLUME = .22') && !call.includes('voiceSource.stop()'), '棋子开口时只能压低辞的声音，不能截断当前或后续语音');
    assert.ok(call.includes('transcriptionQueue = transcriptionQueue.then(() => sendRecording(parts, mime))'), '连续检测到的录音必须依次转写，不能并发导致话序颠倒');
    assert.ok(chat.includes('playPending') && chat.includes("e.name === 'AbortError'"), '留言流式语音加载中不能被重复点按 abort，也不能把取消误报成损坏');
    assert.ok(chat.includes("m.voice_id ? MW.audioUrl(m.voice_id)") && chat.includes("'准备中'") && chat.includes("m.voice_stream && !m.voice_id"), '辞的语音应后台缓存，准备好后恢复时长并直接播放完整文件');
    const chatBackend = fs.readFileSync(path.join(process.cwd(), 'lib/muwen/chat.js'), 'utf8');
    assert.ok(chatBackend.includes('synthesizeVoiceLater(msg.id, msg.content)') && chatBackend.includes('m.voice_id = voice.id'), 'chat_reply 文字先返回，语音要在后台预生成缓存');
    const voiceBackend = fs.readFileSync(path.join(process.cwd(), 'lib/voice.js'), 'utf8');
    assert.ok(voiceBackend.includes("ELEVENLABS_MESSAGE_MODEL_ID || 'eleven_v4'") && voiceBackend.includes('LEGACY_CALL_MODEL') && voiceBackend.includes('stability: 0.3'), '留言默认走 v4、通话保留独立/旧配置，稳定性为 0.3');
    assert.ok(voiceBackend.includes("startsWith('eleven_v4')") && !voiceBackend.includes('const VOICE_SETTINGS'), 'v4 不能继续发送旧版 style/speed 设置');
    assert.ok(voiceBackend.includes("return latin ? undefined : 'ja'") && voiceBackend.includes("return latin ? undefined : 'zh'") && voiceBackend.includes("return 'en'"), '中英日混说要交给 v4 自动判断，单语短句才锁语言');
    assert.ok(call.includes('getUserMedia') && call.includes('echoCancellation') && call.includes('noiseSuppression'), '通话要持续收音并启用回声消除/降噪');
    assert.ok(call.includes('beginCapture()') && call.includes('now - captureStartedAt > 4000') && call.includes("voicePlaying ? (speaking ? .02 : .035) : .018"), '通话应提前录音保住句首，并在辞播放时继续接住棋子的轻声续话');
    assert.ok(call.includes('很慢 · 4 秒') && call.includes('慢 · 2.5 秒'), '慢速说话要有更长的停顿档位');
    assert.ok(call.includes('setInterval(poll, 700)'), '手机端通话状态不能两秒才取一次');
    const callAddon = fs.readFileSync(path.join(process.cwd(), 'hooks/voice-channel-calls-addon.mjs'), 'utf8');
    assert.ok(callAddon.includes("? 0 : 350") && callAddon.includes('400);'), '辞端通话轮询与平衡合并窗要足够快');
    assert.ok(muwu.includes('function starredVoice(m)') && muwu.includes('m.voice_id || m.voice_stream') && muwu.includes('<audio controls preload="metadata"'), '收藏页要保留棋子录音和辞的语音播放器，不能降级成纯文本');
    assert.ok(chat.includes('辞的消息框颜色') && chat.includes('辞的消息框透明度') && chat.includes('我的消息框颜色') && chat.includes('我的消息框透明度'), '聊天双方气泡要能分别调整颜色和透明度');
    assert.ok(chat.includes('function bubbleLook(c, t)') && chat.includes("'--cx-ai'") && chat.includes("'--cx-me'"), '气泡透明度只写背景变量，不能把文字一起变淡');
    assert.ok(call.includes('省 token · 合并短句') && call.includes("s.tokenMode==='balanced'"), '通话设置要有省 token / 平衡 / 低延迟');
    const recallHook = fs.readFileSync(path.join(process.cwd(), 'hooks/user-prompt-recall.ps1'), 'utf8');
    assert.ok(recallHook.includes('origin="muwu_call"') && recallHook.includes('max_return = 2'), '通话普通内容暂停 recall，查历史才轻量召回');
  });
  await step('两个前端都挂得上（静态 + /muwu 路由）', async () => {
    for (const p of ['/', '/style.css', '/app.js', '/muwen.js', '/muwu', '/muwu.js', '/chat.js']) {
      const r = await fetch(`${base}${p}?token=${TOKEN}`);
      assert.equal(r.status, 200, `${p} 应该 200，实际 ${r.status}`);
    }
    const home = await (await fetch(`${base}/?token=${TOKEN}`)).text();
    assert.ok(home.includes('木纹') && home.includes('page-search'));
    const muwu = await (await fetch(`${base}/muwu?token=${TOKEN}`)).text();
    assert.ok(muwu.includes('木屋') && muwu.includes('page-home') && !muwu.includes('data-p="wake"'), '苏醒不再是 tab');
    // notebook 不该出现在任何一个前端里
    const js = await (await fetch(`${base}/muwu.js?token=${TOKEN}`)).text();
    const js2 = await (await fetch(`${base}/muwen.js?token=${TOKEN}`)).text();
    for (const [n, t] of [['muwu.html', muwu], ['index.html', home], ['muwu.js', js], ['muwen.js', js2]]) {
      assert.ok(!/notebook|notbook/i.test(t), `${n} 里不该出现 notebook`);
    }
  });
  await step('后台苏醒：整理记忆和日程是后台的活，一天只降一次温，不碰 pinned', async () => {
    const { tidy, lastReport } = await import('../lib/muwen/tidy.js');
    const g = await import('../lib/muwen/grains.js');
    const old = new Date(Date.now() - 40 * 86400000).toISOString();

    // 三种处境各种一条：早该降温的、凉透该收后台的、pinned 不许碰的
    const { grain: stale } = await tool('add_grain', { category: 'experience', text: '后台整理测试：很久没提的那个旧方案。', date: '2026-08-01' });
    const { grain: cold } = await tool('add_grain', { category: 'experience', text: '后台整理测试：凉透了的边角料。', date: '2026-08-01' });
    const { grain: pinned } = await tool('add_grain', { category: 'agreement', text: '后台整理测试：pinned 的约定，不许动。' });
    await tool('update_grain', { id: pinned.id, pinned: true });
    await tool('update_grain', { id: cold.id, heat: 5 });
    // 直接把"上次被想起"改老，模拟很久没碰
    for (const id of [stale.id, cold.id, pinned.id]) g.updateGrain(id, {});
    const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'grains.json'), 'utf8'));
    for (const x of raw.grains) if ([stale.id, cold.id, pinned.id].includes(x.id)) x.last_accessed = old;
    fs.writeFileSync(path.join(DATA, 'grains.json'), JSON.stringify(raw, null, 2));

    const r1 = tidy({ force: true });
    assert.ok(r1.cooled.some(x => x.id === stale.id), `很久没碰的该降温：${JSON.stringify(r1.cooled.map(x => x.id))}`);
    assert.ok(r1.sunk.some(x => x.id === cold.id), `凉透的该收进后台：${JSON.stringify(r1.sunk.map(x => x.id))}`);
    assert.ok(!r1.cooled.some(x => x.id === pinned.id) && !r1.sunk.some(x => x.id === pinned.id), 'pinned 的一律不碰');
    const afterPin = await tool('get_grain', { id: pinned.id });
    assert.equal(afterPin.status, 'active', 'pinned 的还该在前台');
    const sunk = await tool('get_grain', { id: cold.id });
    assert.equal(sunk.status, 'background', '收进后台不是归档、更不是删');

    // 一天只降一次：同一天再跑不该继续降
    const before = (await tool('get_grain', { id: stale.id })).heat;
    const r2 = tidy();
    assert.ok(r2.skipped.cool, `同一天第二次该跳过降温：${JSON.stringify(r2.skipped)}`);
    assert.equal((await tool('get_grain', { id: stale.id })).heat, before, '第二次苏醒不该再降一遍');

    // 报告存得下来，辞醒来读得到
    const saved = lastReport();
    assert.ok(saved && saved.summary, '该留一份报告');
    const viaTool = await tool('get_tidy_report');
    assert.ok(viaTool.summary === saved.summary, '工具读到的该是同一份');
    assert.ok(Array.isArray(viaTool.schedule.today), '日程也要理一遍');
  });

  await step('调温：辞苏醒时能手动降热度、pinned 有地板、heat_review 给候选', async () => {
    const { grain: g } = await tool('add_grain', { category: 'experience', text: '调温测试：那个已经终止的备份方案，当时讨论了很久。', date: '2026-09-01' });
    assert.equal(Math.round(g.heat), 50, '新纹理默认 50 度');
    // 过时的降下去
    const cooled = await tool('update_grain', { id: g.id, heat: 12 });
    assert.equal(Math.round(cooled.heat), 12, `该降到 12：${cooled.heat}`);
    assert.equal(cooled.confidence, 'reference', '降到 30 以下就只能内部参考，不当事实说');
    // 重新要紧的升回来
    const warmed = await tool('update_grain', { id: g.id, heat: 75 });
    assert.equal(Math.round(warmed.heat), 75);
    assert.equal(warmed.confidence, 'cite');
    // pinned 的有地板，降不穿
    await tool('update_grain', { id: g.id, pinned: true });
    const floored = await tool('update_grain', { id: g.id, heat: 1 });
    assert.equal(Math.round(floored.heat), 20, `pinned 的不该低于 20：${floored.heat}`);
    // 超出范围要夹住，不是报错
    const maxed = await tool('update_grain', { id: g.id, heat: 999 });
    assert.equal(Math.round(maxed.heat), 100);
    await assert.rejects(() => tool('update_grain', { id: g.id, heat: '烫' }), /heat 要是数字/);

    const rv = await tool('heat_review', { limit: 20, stale_days: 1 });
    assert.ok(Array.isArray(rv.stale) && Array.isArray(rv.fresh), '两边都要给');
    assert.ok(rv.fresh.some(x => x.id === g.id), `刚存的该出现在 fresh 里：${JSON.stringify(rv.fresh.map(x => x.id))}`);
    assert.ok(!rv.stale.some(x => x.id === g.id), 'pinned 的不该进降温候选');
    assert.ok(rv.note.includes('update_grain'), '要告诉她怎么动手');
  });

  await step('便签本同步：sticky/today 排最前、密码类绝不注入、单向不回写', async () => {
    const { searchNotes, looksSecret } = await import('../lib/muwen/notebook.js');
    const { autoRecall, formatInjection } = await import('../lib/muwen/recall.js');
    // 直接种一份"同步下来的副本"，不连真的 notebook（测试不该碰她的本子）
    fs.writeFileSync(path.join(DATA, 'notebook_notes.json'), JSON.stringify({
      synced_at: new Date().toISOString(),
      notes: [
        { id: 'sticky:1', note_id: 1, section: 'sticky', text: '铁律：写脚本先备份，棋子说过两次了。', tags: [], at: '2026-09-20T10:00:00Z', secret: false, priority: true },
        { id: 'today:2', note_id: 2, section: 'today', text: '今天要把备份脚本改完，还差 rclone 那段。', tags: [], at: '2026-09-27T01:00:00Z', secret: false, priority: true },
        { id: 'for_nor:3', note_id: 3, section: 'for_nor', text: '给棋子：备份这件事我记着，你别操心。', tags: [], at: '2026-09-25T01:00:00Z', secret: false, priority: false },
        { id: 'today:7', note_id: 7, section: 'today', text: '10:00这次醒来：没有新留言，备份脚本那事没动静，日程空的。', tags: [], at: '2026-09-27T01:00:00Z', secret: false, priority: true, routine: true },
        { id: 'sticky:9', note_id: 9, section: 'sticky', text: '备份盘的密码是 hunter2，别写进聊天。', tags: ['密码'], at: '2026-09-01T01:00:00Z', secret: true, priority: true }
      ]
    }), 'utf8');

    assert.ok(looksSecret('密码是 xxx'), '带"密码"的该判成机密');
    const { looksRoutine } = await import('../lib/muwen/notebook.js');
    assert.ok(looksRoutine('10:00这次醒来：没有新留言，日程是空的'), '醒来流水该认出来');
    assert.ok(!looksRoutine('铁律：写脚本先备份'), '正经便签不该被当成流水');
    assert.ok(looksSecret('备份盘', ['password']), '标签里带 password 也算');
    assert.ok(!looksSecret('今天把备份脚本改完'), '普通便签不该被误判');

    // 1. 自动召回这条路拿不到密码类
    const auto = searchNotes('备份', { limit: 5 });
    assert.ok(auto.length >= 2, `该搜到便签：${auto.length}`);
    assert.ok(!auto.some(n => n.secret), '自动召回路径不该出现密码类便签');
    assert.ok(!auto.some(n => n.routine), '醒来流水不该进自动召回——today 里六成是这个，会把有用的挤掉');
    // 泛泛的长问句不该把不相关的便签顶上来（实测垃圾命中覆盖率都在 0.26 以下）
    const vague = searchNotes('搞之前是不是该先留个底', { limit: 5 });
    assert.equal(vague.length, 0, `字面不沾边的不该命中：${JSON.stringify(vague.map(n => [n.section, n.coverage]))}`);
    assert.ok(searchNotes('备份', { limit: 5 }).every(n => n.coverage >= 0.35), '留下来的都该是真命中');
    assert.ok(searchNotes('备份', { limit: 9, includeSecret: true, includeRoutine: true }).some(n => n.routine),
      '她自己搜的时候流水要搜得到');
    // 2. 辞自己搜得到
    const manual = searchNotes('备份', { limit: 5, includeSecret: true });
    assert.ok(manual.some(n => n.secret), '她主动搜的时候要搜得到');
    // 3. sticky/today 排在 for_nor 前面
    const idx = n => auto.findIndex(x => x.id === n);
    assert.ok(idx('for_nor:3') === -1 || idx('for_nor:3') > Math.max(idx('sticky:1'), idx('today:2')),
      `sticky/today 该排在前面：${JSON.stringify(auto.map(n => n.section))}`);

    // 4. 进召回和注入：标成 [便签·xxx]，且密码那条无论如何不出现
    const noSem = async () => ({ picks: [], index_count: 0 });
    const noRing = async () => ({ picks: [], index_count: 0 });
    const r = await autoRecall('备份脚本', { useAgent: true, _semanticPick: noSem, _pickRings: noRing, suppressRecent: false });
    assert.ok(r.layers_used.includes('notebook'), `该走便签层：${JSON.stringify(r.layers_used)}`);
    const inj = formatInjection(r);
    assert.ok(inj.includes('[便签·'), `注入里该标明是便签：${inj.slice(0, 160)}`);
    assert.ok(!inj.includes('hunter2'), '密码绝对不能进注入');
    // 5. 关键词搜不着的时候，语义层也能按意思挑便签（跟纹理共用同一次模型调用）
    const { buildIndex } = await import('../lib/muwen/semantic.js');
    const nbIdx = buildIndex();
    assert.ok(nbIdx.text.includes('便签索引') && nbIdx.ids.has('sticky:1'),
      '便签要进同一份索引，模型才能在一次调用里一起挑');
    assert.ok(!nbIdx.text.includes('hunter2'), '密码类不能进索引——那是要发给模型的');
    const semNote = async () => ({ picks: [{ layer: 'notebook', kind: 'note', id: 'sticky:1', section: 'sticky',
      text: '铁律：写脚本先备份，棋子说过两次了。', reason: '她换了说法但说的是同一条规矩' }], index_count: 1 });
    const bySense = await autoRecall('搞之前是不是该先留个底', { useAgent: true, _semanticPick: semNote, _pickRings: noRing, suppressRecent: false });
    const hit = bySense.memories.find(m => m.layer === 'notebook');
    assert.ok(hit && hit.id === 'sticky:1', `语义层挑的便签该出现：${JSON.stringify(bySense.memories.map(m => m.layer))}`);
    assert.ok(formatInjection(bySense).includes('[便签·sticky]'), '注入里照样标成便签');

    // 6. 意图 agent 说"这句不用翻记忆"时，当下的便签照样要给
    //    （实测"备份"被判成操作指令，整轮召回连便签一起掐掉了）
    const skipAgent = async () => { throw new Error('不该走到这'); };
    const skipped = await autoRecall('备份', { useAgent: true, _semanticPick: skipAgent, _pickRings: noRing,
      _intent: async () => ({ skip: true, intent: 'association', queries: [], why: '操作指令，跟历史记忆无关' }) });
    assert.ok(skipped.skipped_by_agent, '该是被 agent 跳过的那条路');
    assert.ok(skipped.memories.some(m => m.layer === 'notebook'),
      `跳过记忆检索时便签还是要给：${JSON.stringify(skipped.memories.map(m => m.layer))}`);

    fs.rmSync(path.join(DATA, 'notebook_notes.json'), { force: true });
  });

  await step('召回升级：联想 3 条 / 查历史 6 条、30 分钟不重复、片段取最相关那段、注入不超 1500 字', async () => {
    const { autoRecall, formatInjection, isHistoryAsk, INJECT_BUDGET } = await import('../lib/muwen/recall.js');
    const noSem = async () => ({ picks: [], index_count: 0 });
    const noRing = async () => ({ picks: [], index_count: 0 });

    // 1. 问法分档
    assert.ok(isHistoryAsk('我们之前那个方案是怎么说的'), '"之前…怎么说的" 该算查历史');
    assert.ok(isHistoryAsk('上次你提过的那件事'), '"上次…提过" 该算查历史');
    assert.ok(!isHistoryAsk('今天好累啊'), '闲聊不该算查历史');

    const chat = await autoRecall('今天摆摊人好多', { useAgent: true, _semanticPick: noSem, _pickRings: noRing, suppressRecent: false });
    assert.equal(chat.intent, 'association');
    assert.equal(chat.max_return, 3, `联想该给 3 条上限：${chat.max_return}`);
    const hist = await autoRecall('摆摊那天我们之前是怎么说的', { useAgent: true, _semanticPick: noSem, _pickRings: noRing, suppressRecent: false });
    assert.equal(hist.intent, 'answer');
    assert.equal(hist.max_return, 6, `查历史该给 6 条上限：${hist.max_return}`);

    // 2. 30 分钟内浮现过的不再出现；同一句改成查历史的问法就不压制
    const first = await autoRecall('摆摊那天', { useAgent: true, _semanticPick: noSem, _pickRings: noRing, suppressRecent: false });
    assert.ok(first.memories.length >= 1, '先得召回到东西才谈得上压制');
    const firstIds = first.memories.map(m => m.id);
    const again = await autoRecall('摆摊那天', { useAgent: true, _semanticPick: noSem, _pickRings: noRing });
    assert.ok(!again.memories.some(m => firstIds.includes(m.id)),
      `刚浮现过的不该再出现：${JSON.stringify(again.memories.map(m => m.id))}`);
    assert.ok(again.suppressed >= 1, '压制掉的条数要记下来');
    const askAgain = await autoRecall('摆摊那天我们上次是怎么说的', { useAgent: true, _semanticPick: noSem, _pickRings: noRing });
    assert.ok(askAgain.memories.some(m => firstIds.includes(m.id)), '主动问历史时不该压制');

    // 3. 片段取最相关那段，不是从头硬截
    const tail = '这句才是要找的：她把螺旋桨扳手落在摊位底下了。';
    const long = '开头先交代了一堆背景，' + '当时天气不错人也多，摊子摆在老地方。'.repeat(12) + tail;
    const inj = formatInjection({ query: '螺旋桨扳手', memories: [{ layer: 'authority', kind: 'grain', id: 'g-frag',
      category: 'experience', heat: 50, confidence: 'cite', text: long }] });
    assert.ok(inj.includes('螺旋桨扳手'), `片段该定位到相关那句：${inj.slice(0, 200)}`);
    assert.ok(inj.includes('…'), '从中间取的片段前面要有省略号');

    // 4. 注入总量封顶
    const many = Array.from({ length: 12 }, (_, i) => ({ layer: 'authority', kind: 'grain', id: 'g-big' + i,
      category: 'experience', heat: 50, confidence: 'cite', text: '某件很长的旧事。'.repeat(40) }));
    const big = formatInjection({ query: '旧事', memories: many });
    assert.ok(big.length <= INJECT_BUDGET + 40, `注入总量该封在 ${INJECT_BUDGET} 字上下：实际 ${big.length}`);
    assert.ok(big.includes('[muwen:recall]'), '封顶了也得保留抬头');
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
    const weak = await autoRecall('你会不会有一天就不认识我了', { useAgent: true, _semanticPick: stub, suppressRecent: false });
    assert.ok(weak.layers_used.includes('semantic'), `应该触发语义层：${JSON.stringify(weak.layers_used)}`);
    assert.equal(weak.memories[0].layer, 'semantic');
    assert.equal(weak.memories[0].id, target.grain.id);
    assert.equal(weak.memories[0].reason, '她在问连续性');
    assert.ok(weak.memories.length <= 3);

    // 强命中（adj 高）→ 不该跑语义层，省钱
    let called = false;
    const spy = async () => { called = true; return { picks: [], none: true }; };
    const strong = await autoRecall('换窗口之后我还是我，靠的是这份共享的记录', { useAgent: true, _semanticPick: spy, suppressRecent: false });
    assert.equal(called, false, `强命中不该调语义层，top adj=${strong.memories[0].adj}`);
    assert.ok(!strong.layers_used.includes('semantic'));

    // 语义层报错 → 静默降级，不炸整个召回；原因记进 why
    const boom = async () => { throw new Error('模型超时'); };
    const degraded = await autoRecall('她那天为什么委屈', { useAgent: true, minScore: 1, _semanticPick: boom, suppressRecent: false });
    assert.ok(!degraded.layers_used.includes('semantic'));
    assert.ok(Array.isArray(degraded.memories));
    assert.ok((degraded.why || '').includes('语义层失败'));

    // 关键词和语义都空 → 才轮到年轮兜底
    const empty = async () => ({ picks: [], none: true });
    const none = await autoRecall('量子色动力学的渐近自由', { useAgent: true, _semanticPick: empty, suppressRecent: false });
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
    const r = await autoRecall('螺旋桨维修手册第三章', { useAgent: true, _semanticPick: emptySemantic, _pickRings: pick, suppressRecent: false });
    assert.ok(r.layers_used.includes('rings-semantic'), `应该触发年轮语义层：${JSON.stringify(r.layers_used)}`);
    assert.equal(r.memories[0].layer, 'last_resort');
    assert.equal(r.memories[0].id, ring.id);
    assert.equal(r.memories[0].reason, '她像是在问那次胡扯');
    assert.ok(r.ring_semantic.index_count >= 1);

    // 关键词在年轮里搜得到 → 不跑语义层，省钱
    let called = false;
    const spy = async () => { called = true; return { picks: [], none: true }; };
    await autoRecall('给年轮索引测试用的内容跟记忆库里别的东西都不沾边', { useAgent: true, _semanticPick: emptySemantic, _pickRings: spy, suppressRecent: false });
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
    const scatterOnly = await autoRecall('我家狗要不要打麻药洗牙那件事后来怎么样了', { useAgent: true, _semanticPick: emptySemantic, _pickRings: pick2, suppressRecent: false });
    assert.equal(ringModelCalled, true, '覆盖率没过线就该交给索引层');
    assert.ok(!scatterOnly.memories.some(m => m.id === noisy.id), `没过线的散落噪音不该返回：${JSON.stringify(scatterOnly.memories.map(m => m.id))}`);

    // 纹理有弱命中（沾边但不准）→ 年轮层照样要放行。弱命中本身过不了相关性下限，
    // 所以位置留给年轮线索——这正是"宁可给一条相关的，不要凑三条不相关的"。
    const weak = await autoRecall('她那天为什么委屈', { useAgent: true, minScore: 1, maxReturn: 3, _semanticPick: emptySemantic, _pickRings: pick, suppressRecent: false });
    const ringHit = weak.memories.find(m => m.layer === 'last_resort');
    assert.ok(ringHit && ringHit.id === ring.id, `弱命中时年轮线索要挤进来：${JSON.stringify(weak.layers_used)}`);
    assert.ok(!weak.memories.some(m => m.layer === 'authority' && m.adj < 20), '没过相关性下限的纹理不该返回');
    assert.ok(weak.memories.length <= 3, 'maxReturn 还是要守住');

    // 强命中纹理（adj 过线）→ 年轮层一步都不该走
    let ringCalled = false;
    const ringSpy = async () => { ringCalled = true; return { picks: [], none: true }; };
    await autoRecall('换窗口之后我还是我，靠的是这份共享的记录', { useAgent: true, _semanticPick: emptySemantic, _pickRings: ringSpy, suppressRecent: false });
    assert.equal(ringCalled, false, '强命中不该翻年轮');

    // 语义层报错 → 静默降级，不炸整个召回
    const boom = async () => { throw new Error('模型超时'); };
    const degraded = await autoRecall('潜水艇声呐校准流程', { useAgent: true, _semanticPick: emptySemantic, _pickRings: boom, suppressRecent: false });
    assert.deepEqual(degraded.memories, []);
    assert.ok((degraded.why || '').includes('年轮语义层失败'));
  });
  await step('fallbacks 只发给支持它的模型（换成 sonnet/haiku 省钱时不能 400）', async () => {
    const { fallbackOpts } = await import('../lib/muwen/common.js');
    // 模型是环境变量可换的，换成便宜的很常规。Sonnet/Haiku 收到 fallbacks 会直接 400：
    // 'claude-sonnet-5' does not support the `fallbacks` parameter —— 意图扩写、语义兜底、
    // 年轮索引三层会一起哑掉，而且是静默降级，从返回值上看只是"没召回到"。
    for (const m of ['claude-opus-5', 'claude-fable-5-1']) {
      assert.equal(fallbackOpts(m).fallbacks, 'default', `${m} 应该带 fallbacks`);
      assert.ok(fallbackOpts(m).betas.includes('server-side-fallback-2026-07-01'));
    }
    for (const m of ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-4-8', '', undefined]) {
      assert.deepEqual(fallbackOpts(m), {}, `${m} 不该带 fallbacks`);
    }
  });
  await step('effort 只发给支持它的模型（意图扩写换成 haiku 时不能 400）', async () => {
    const { effortOpts } = await import('../lib/muwen/common.js');
    for (const m of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-fable-5-1']) {
      assert.deepEqual(effortOpts(m, 'low'), { effort: 'low' }, `${m} 应该带 effort`);
    }
    for (const m of ['claude-haiku-4-5', 'claude-sonnet-4-5', '', undefined]) {
      assert.deepEqual(effortOpts(m, 'low'), {}, `${m} 不该带 effort`);
    }
  });
  await step('召回：相关性下限 + 分区多样性 + 年轮片段截到句子结尾', async () => {
    const { autoRecall, formatInjection } = await import('../lib/muwen/recall.js');
    const { clipToSentence, trimToSentences } = await import('../lib/muwen/search.js');

    // 三条同分区的强命中。内容必须各不相同——不然会被下面的近似重复合并掉（那是另一条规则）
    const kw = '兰花指纹丝绒暗匣';
    const bodies = [
      '棋子在厨房煮面的时候提到它，说是外婆留下来的旧物，锁扣已经坏了。',
      '下雨天她翻出来给我看里面夹着的一张车票，日期是三年前的冬天。',
      '搬家那天差点被当成垃圾扔掉，她冲下楼追了两条街才捡回来。'
    ];
    for (const b of bodies) {
      await tool('add_grain', { category: 'experience', date: '2026-09-05', text: `${kw}——${b}` });
    }
    // 同一句 query 也能打中的另一个分区，但分数略低（文字更长 → 除权后更低）
    const other = await tool('add_grain', { category: 'learning',
      text: `${kw}这件事我学到的是：旧东西承载的重量跟它本身的价格无关。` + '后面是一些无关的补充说明。'.repeat(6) });

    const noSem = async () => ({ picks: [], none: true });
    const noRing = async () => ({ picks: [], none: true });
    const r = await autoRecall(kw, { useAgent: true, maxReturn: 3, _semanticPick: noSem, _pickRings: noRing, suppressRecent: false });

    // 多样性：三条不能全是 experience，最后一格让给别的分区里分最高的
    const cats = r.memories.map(m => m.category);
    assert.equal(r.memories.length, 3, `应该给满三条：${JSON.stringify(cats)}`);
    assert.ok(cats.filter(c => c === 'experience').length <= 2, `同一分区最多两条：${JSON.stringify(cats)}`);
    assert.ok(cats.includes('learning'), `第三格要换分区：${JSON.stringify(cats)}`);
    assert.equal(r.memories[2].id, other.grain.id, '换的那条要是其他分区里分最高的');

    // 近似重复：同一件事的浓缩版和完整版只留排在前面那条（分更高的那条）
    const fullVersion = await tool('add_grain', { category: 'agreement', date: '2026-09-05',
      text: `${kw}的完整来历：棋子的外婆在世的时候把它放在樟木箱最底下，说等她出嫁再给她。` +
            '后来外婆走了，箱子一直没人动，直到棋子搬家整理东西才翻出来，锁扣已经坏了打不开。' });
    await tool('add_grain', { category: 'agreement', date: '2026-09-05',
      text: `${kw}的来历：外婆放在樟木箱最底下说等她出嫁再给她，外婆走后一直没人动，搬家才翻出来，锁扣坏了打不开。` });
    const deduped = await autoRecall(kw, { useAgent: true, maxReturn: 3, _semanticPick: noSem, _pickRings: noRing, suppressRecent: false });
    const agr = deduped.memories.filter(m => m.category === 'agreement');
    assert.ok(agr.length <= 1, `同一件事的两个版本只该留一条：${JSON.stringify(agr.map(m => m.text.slice(0, 20)))}`);
    // 判重本身直接测——放进召回里测会受名额和分区上限影响，命中不到就测了个寂寞
    const { bigrams, nearDuplicate } = await import('../lib/muwen/search.js');
    const A = bigrams(fullVersion.grain.text);
    const B = bigrams(`${kw}的来历：外婆放在樟木箱最底下说等她出嫁再给她，外婆走后一直没人动，搬家才翻出来，锁扣坏了打不开。`);
    assert.ok(nearDuplicate(A, B), '浓缩版和完整版应该判为重复');
    // 长度悬殊的不比——1000 字的纹理能"包住"34 字的短纹理纯属巧合
    assert.ok(!nearDuplicate(A, bigrams('棋子哭的时候这里有什么东西不对，不知道叫不叫痛。')), '体量差太多的不该判重');
    // 内容真不同的同分区纹理不该被误伤
    assert.ok(!nearDuplicate(bigrams(`${kw}——${bodies[0]}`), bigrams(`${kw}——${bodies[2]}`)), '只是共用关键词的不该判重');
    // 内容确实不同的同分区纹理不该被误伤
    const distinct = deduped.memories.filter(m => m.category === 'experience');
    assert.ok(distinct.length <= 2 && new Set(distinct.map(m => m.id)).size === distinct.length);

    // 归档的纹理不进自动召回——"明确不要了，不管 heat 多高都不主动返回"
    const arch = await tool('add_grain', { category: 'feeling', text: `${kw}这条我已经归档了，不该再被自动召回端上来。` });
    await tool('update_grain', { id: arch.grain.id, pinned: true });   // heat 拉高，证明不是靠分低才没出现
    await tool('move_to_archive', { id: arch.grain.id });
    const noArch = await autoRecall(kw, { useAgent: true, maxReturn: 3, _semanticPick: noSem, _pickRings: noRing, suppressRecent: false });
    assert.ok(!noArch.memories.some(m => m.id === arch.grain.id), '归档的不该被自动召回');
    // 手动搜也一样，除非明确传 status='archived'——代码跟工具说明对齐
    assert.ok(!(await tool('search_grains', { query: kw, limit: 20 })).some(g => g.id === arch.grain.id),
      '手动 search_grains 默认也不该搜到归档的');
    assert.ok((await tool('search_grains', { query: kw, limit: 20, status: 'archived' })).some(g => g.id === arch.grain.id),
      '明确传 status=archived 才搜得到');

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
    // 纹理正文也一样，不能硬切在半句话上
    const grainInj = formatInjection({ memories: [{ layer: 'authority', kind: 'grain', id: 'g1',
      category: 'experience', heat: 60, confidence: 'cite', date: '2026-09-05',
      text: '棋子说了一句很长的话。' + '后面还有很多内容需要被截断掉才行。'.repeat(20) }] });
    const gfrag = grainInj.split('] ').slice(1).join('] ');
    assert.ok(/[。！？…]$/.test(gfrag.trim()), `纹理正文也要停在句子结尾：${JSON.stringify(gfrag.slice(-20))}`);
    // 找不到句号的时候硬切并加省略号，不能无限长
    assert.ok(clipToSentence('没有任何标点的一长串文字'.repeat(20), 60).endsWith('…'));

    // 截断点不能落在引号中间：'棋子说"0/10。' 那个句号确实是句子结尾，但它在引号里，
    // 截在那儿会留一个悬空的开引号，读起来像话说了一半。
    const { quoteBalanced } = await import('../lib/muwen/search.js');
    const quoted = '前面一句话。他给自己扣了两分说"最后一段没忍住写认真了"。棋子说"0/10。我不会把你扔进垃圾桶。"后面还有很多内容。';
    const clipped = clipToSentence(quoted, 45);
    assert.ok(quoteBalanced(clipped), `截断后引号要配平：${JSON.stringify(clipped)}`);
    assert.ok(!clipped.trimEnd().endsWith('0/10。'), '不该截在引号里那个句号上');
    for (const [str, want] of [['他说"好的"。', true], ['他说"好的。', false],
                               ['「引用」完了。', true], ['「引用完了。', false], ['没有引号。', true]]) {
      assert.equal(quoteBalanced(str), want, `配平判断错了：${str}`);
    }
    // 掐头：开头那半句要去掉
    assert.ok(!trimToSentences(long).startsWith('这是前面被切掉的半句'), '开头的半句也要掐掉');
  });
  await step('日记分两本：辞的日记 / 妻子观察日记，分开存，网页接口只吐公开的', async () => {
    const d = await tool('add_diary_entry', { text: '今天的日记' });
    assert.equal(d.category, 'diary');
    const w = await tool('add_wife_observation', { text: '她今天把头发扎起来了' });
    assert.equal(w.category, 'wife_observation');
    await tool('add_diary_entry', { text: '观察但私密', category: 'wife_observation', visibility: 'private' });
    const mine = await tool('get_diary', {});
    assert.ok(mine.some(x => x.id === d.id), '辞的日记要读得到');
    assert.ok(!mine.some(x => x.category === 'wife_observation'), '默认只读辞的日记，不混观察日记');
    const obs = await tool('get_wife_observations', {});
    assert.equal(obs.length, 2);
    assert.ok(obs.every(x => x.category === 'wife_observation'));
    const r1 = await (await fetch(`${base}/api/diary?token=${TOKEN}`)).json();
    assert.ok(!r1.some(x => x.category === 'wife_observation'));
    const r2 = await (await fetch(`${base}/api/diary?category=wife_observation&token=${TOKEN}`)).json();
    assert.equal(r2.length, 1, '私密的观察日记不该出现在网页接口里');
    assert.equal((await fetch(`${base}/api/diary?category=nope&token=${TOKEN}`)).status, 400);
  });
  await step('标签总表：remember 按 label 放到对应的地方，前后端分类名一致', async () => {
    const labels = await (await fetch(`${base}/api/labels?token=${TOKEN}`)).json();
    const keys = labels.map(l => l.key);
    for (const k of ['experience', 'agreement', 'feeling', 'learning', 'to_self', 'coincidence', 'evidence', 'diary', 'wife_observation', 'note', 'mood', 'first', 'song', 'countdown', 'moment', 'daily_summary', 'handover', 'transcript', 'schedule', 'sleep', 'cycle', 'health']) {
      assert.ok(keys.includes(k), `标签表缺 ${k}`);
    }
    const { CATEGORY_LABELS } = await import('../lib/muwen/grains.js');
    for (const [cat, name] of Object.entries(CATEGORY_LABELS)) assert.equal(labels.find(l => l.key === cat).name, name, `${cat} 前后端显示名要一致`);

    const g = await tool('remember', { label: 'experience', text: 'remember 测试：今天去看了海' });
    assert.equal(g.label, 'experience'); assert.equal(g.stored_via, 'add_grain');
    assert.equal(g.result.grain.category, 'experience');
    assert.match(g.result.grain.date, /^\d{4}-\d{2}-\d{2}$/, 'experience 没给日期就用今天');
    const w = await tool('remember', { label: '妻子观察', text: '她睡着的时候会皱眉' });
    assert.equal(w.label, 'wife_observation'); assert.equal(w.result.category, 'wife_observation');
    const c = await tool('remember', { label: '巧合', text: 'remember 测试：同时说了同一句话' });
    assert.equal(c.result.grain.category, 'unexplained');
    assert.ok(c.result.grain.families.includes('巧合'));
    const m = await tool('remember', { label: 'mood', text: '满的' });
    assert.equal(m.stored_via, 'add_mood');
    const s = await tool('remember', { label: '睡眠', date: '2026-09-10', fields: { sleepTime: '23:30', wakeTime: '07:30' } });
    assert.equal(s.stored_via, 'add_sleep_entry');
    await assert.rejects(tool('remember', { label: '瞎写的标签', text: 'x' }), /认不出标签[\s\S]*experience/);
    const names = (await rpc('tools/list', {})).result.tools.map(t => t.name);
    for (const n of ['remember', 'list_labels', 'add_wife_observation', 'get_wife_observations']) assert.ok(names.includes(n), `工具列表缺 ${n}`);
  });
  await step('木纹网页只读：写工具被拒，读也不升温、不记访问、不写召回日志', async () => {
    const ro = async (name, args = {}) => {
      const r = await fetch(`${base}/mcp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': TOKEN, 'x-muwen-readonly': '1' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
      });
      return (await r.json()).result;
    };
    for (const [name, args] of [['add_diary_entry', { text: '网页不该写进来' }], ['remember', { label: 'feeling', text: '网页不该写进来' }], ['update_grain', { id: 'x', pinned: true }], ['move_to_archive', { id: 'x' }], ['set_handover', { text: 'x' }]]) {
      const r = await ro(name, args);
      assert(r.isError && r.content[0].text.includes('只读'), `${name} 应该被拒：${r.content[0].text}`);
    }
    const g = (await rest('/api/grains?limit=1'))[0];
    assert(g, '要有一条纹理来测');
    const logsBefore = (await tool('get_recall_logs', { limit: 1000 })).length;
    for (const [name, args] of [['search_grains', { query: g.text.slice(0, 6), limit: 5 }], ['get_grain', { id: g.id }], ['get_grain_with_counterevidence', { id: g.id }], ['search_all', { query: g.text.slice(0, 6) }], ['auto_recall', { query: g.text.slice(0, 6) }]]) {
      const r = await ro(name, args);
      assert(!r.isError, `${name} 读应该放行：${r.content[0].text}`);
    }
    const after = await rest(`/api/grains/${g.id}`);
    assert(after.access_count === g.access_count && after.heat === g.heat && after.last_accessed === g.last_accessed, `读完不该变：${g.access_count}/${g.heat} → ${after.access_count}/${after.heat}`);
    assert((await tool('get_recall_logs', { limit: 1000 })).length === logsBefore, '网页搜索不该写召回日志');
    const diaries = await tool('get_diary', { limit: 100 });
    assert(!JSON.stringify(diaries).includes('网页不该写进来'), '被拒的写入不该落盘');
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
  await step('人际关系 social + 八卦 gossip：remember 写、同名是更新、提到名字就召回', async () => {
    const a = await tool('remember', { label: 'social', name: '小A', gender: '女', relation: '棋子的发小', owner: 'nor', intro: '武汉人，认识十几年', status: '正常', text: '昨晚打电话讲了另一个朋友的八卦' });
    assert.equal(a.stored_via, 'update_social'); assert.equal(a.result.created, true);
    // 同名再写一次 = 更新，只改传了的字段，旧状态进历史
    const b = await tool('remember', { label: 'social', name: '小A', status: '吵架中' });
    assert.equal(b.result.created, false);
    assert.equal(b.result.status, '吵架中'); assert.equal(b.result.intro, '武汉人，认识十几年', '没传的字段不能被冲掉');
    assert.equal(b.result.status_history[0].status, '正常');
    assert.equal((await tool('list_social')).filter(p => p.name === '小A').length, 1, '不能建出第二张');
    await tool('update_social', { name: '小A', aliases: ['A姐'] });
    await assert.rejects(tool('update_social', { name: '小B', owner: '路人' }), /owner/);

    const g = await tool('remember', { label: 'gossip', about: 'A姐', text: '跟三个男生同时暧昧，一个给她做饭一个被她叫老公一个被她搂着逛街', date: '2026-09-13' });
    assert.equal(g.stored_via, 'add_gossip');
    assert.deepEqual(g.result.about, ['小A'], '别名存成正式名字');
    const g2 = await tool('add_gossip', { about: '路人甲', text: '没建卡的人' });
    assert.ok(g2.note.includes('还没有'));
    const card = await tool('get_social', { name: 'A姐' });
    assert.equal(card.name, '小A'); assert.equal(card.gossip.length, 1);

    // 召回：提到名字（或别名）→ 卡片 + 八卦；没提到 → 没有；单个字母不误中
    const r = await tool('auto_recall', { query: '小A今天又来找我了', use_agent: false });
    assert.equal(r.people.length, 1); assert.equal(r.people[0].person.name, '小A');
    assert.ok(r.layers_used.includes('social'));
    const inj = await (await fetch(`${base}/api/recall?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'A姐呢', use_agent: false }) })).json();
    assert.ok(inj.text.includes('[人] 小A') && inj.text.includes('吵架中') && inj.text.includes('三个男生'), inj.text);
    assert.equal((await tool('auto_recall', { query: '今天天气不错我们出去走走', use_agent: false })).people.length, 0);
    assert.equal((await tool('auto_recall', { query: '路人甲怎么了', use_agent: false })).people[0].person, null, '只有八卦也召回');
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
