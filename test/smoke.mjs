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
    for (const n of ['add_grain', 'recall', 'dream', 'search_all', 'save_photo', 'add_mood', 'get_memory', 'add_transcript', 'get_state', 'speak', 'add_schedule']) assert.ok(names.includes(n), n);
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
  await step('add_daily → get_calendar 带 mood_tags / intimate / kiss_count', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
    await tool('add_daily', { date: today, headline: '木纹上线', mood_tags: ['好', '深聊'], nor_status: '累但开心', cy_status: '满的', pending: '拆档案字段', intimate: '1', kiss_count: 12 });
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
  await step('相册：存 / 列 / 取 / 删 + REST 图片', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const p = await tool('save_photo', { image_base64: 'data:image/png;base64,' + png, mime_type: 'image/png', description: '一个像素', tags: ['测试'] });
    const list = await tool('list_photos', { tag: '测试' });
    assert.equal(list.length, 1); assert.ok(!list[0].image_base64);
    const got = await tool('get_photo', { id: p.id });
    assert.equal(got.image_base64, png);
    const img = await fetch(`${base}/api/album/${p.id}/image?token=${TOKEN}`);
    assert.equal(img.headers.get('content-type'), 'image/png');
    await tool('delete_photo', { id: p.id });
    assert.equal((await tool('list_photos')).length, 0);
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
