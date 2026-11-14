// 「值得辞看一眼」记忆候选（lib/muwen/heat-candidates.js）：
//   · 四条规则按优先级挑、封顶 15、附一句机械文案；
//   · 辞标过"看过了"或动过那条就不再列；没处理的顺延；
//   · 02:30–10:30 投一条系统事件进主要窗口队列，一天一次，通话中 / 棋子刚说过话 / 没候选 都不投。
// 跑法：node test/heat-candidates.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muwen-heat-cand-'));
process.env.DATA_DIR = DATA;

const grains = await import('../lib/muwen/grains.js');
const log = await import('../lib/muwen/recall-log.js');
const hc = await import('../lib/muwen/heat-candidates.js');
const tidy = await import('../lib/muwen/tidy.js');
const chat = await import('../lib/muwen/chat.js');
const { timezone, todayStr } = await import('../lib/muwen/common.js');

let failed = 0;
async function step(name, fn) {
  try { await fn(); console.log('✓', name); }
  catch (e) { failed++; console.log('✗', name, '\n  ', e && e.stack || e); }
}
const recent = () => new Date(Date.now() - 3600000).toISOString();
// 找一个"辞时区里今天 HH:MM"的 Date
function atLocal(hhmm) {
  const base = Date.parse(`${todayStr()}T00:00:00Z`) - 24 * 3600000;
  for (let i = 0; i < 48 * 60; i++) {
    const d = new Date(base + i * 60000);
    const hm = d.toLocaleTimeString('en-GB', { timeZone: timezone(), hour: '2-digit', minute: '2-digit', hour12: false });
    if (hm === hhmm && d.toLocaleDateString('en-CA', { timeZone: timezone() }) === todayStr()) return d;
  }
  throw new Error('找不到 ' + hhmm);
}

const A = grains.addGrain({ category: 'experience', text: 'A 两周被召回很多次但热度 0 的那条', date: '2026-08-05' }).grain;
const B = grains.addGrain({ category: 'agreement', text: 'B 钉住了但压在地板上的约定' }).grain;
const C = grains.addGrain({ category: 'feeling', text: 'C 有反证关系的感受' }).grain;
const D = grains.addGrain({ category: 'learning', text: 'D 是 C 的反证' }).grain;
const E = grains.addGrain({ category: 'learning', text: 'E 被翻了很多次却是 0 度的技术笔记' }).grain;
const F = grains.addGrain({ category: 'experience', text: 'F 正常的一条，不该被挑', date: '2026-09-01' }).grain;
grains.updateGrain(A.id, { heat: 0 });
grains.updateGrain(B.id, { pinned: true }); grains.updateGrain(B.id, { heat: 0 });   // pinned 地板 20
grains.addLink(C.id, D.id, 'contradicts');
for (let i = 0; i < 6; i++) grains.touch(E.id, 'read');
grains.updateGrain(E.id, { heat: 0 });
for (let i = 0; i < 5; i++) log.appendRecallLog({ id: `ar${i}`, auto: true, notice: '随便', returned_ids: [A.id, F.id], returned: 2, created_at: recent() });
// 手动 recall 不算"自己浮现"
log.appendRecallLog({ id: 'rc1', auto: false, notice: 'x', returned_ids: [F.id], returned: 1, created_at: recent() });

await step('四条规则按优先级挑出来，正常的不挑，文案是机械的一句', () => {
  const r = hc.buildCandidates();
  const ids = r.candidates.map(c => c.id);
  assert.deepEqual(ids.slice(0, 2), [A.id, B.id], JSON.stringify(r.candidates.map(c => [c.id, c.rule])));
  assert.deepEqual(new Set(ids.slice(2, 4)), new Set([C.id, D.id]));
  assert.equal(ids[4], E.id);
  assert.ok(!ids.includes(F.id), 'F 两周被召回 5 次但热度 50，不该挑');
  const a = r.candidates[0];
  assert.equal(a.rule, 1); assert.ok(a.why.includes('5 次') && a.why.includes('0 度'), a.why);
  assert.equal(r.candidates[1].why, '钉住了，但压在 20 度地板上');
  assert.ok(r.candidates[2].why.includes('反证'));
  assert.ok(r.candidates[4].why.includes('6 次'));
  assert.ok(a.text.length <= 40 && a.listed_at && a.heat === 0 && a.category === 'experience');
  // 没动任何纹理
  assert.equal(grains.getGrain(A.id, { touchIt: false }).heat, 0);
});

await step('标过"看过了"的不再列；辞动过的那条也不再列（而且明天也不回来）', async () => {
  hc.markReviewed([E.id]);
  await new Promise(r => setTimeout(r, 1100));   // updated_at 是秒级的，隔一秒再动才看得出"动过"
  grains.updateGrain(A.id, { heat: 25 });     // 辞升了一点：仍然 <30 且被召回 5 次，但已处理
  const r = hc.buildCandidates();
  const ids = r.candidates.map(c => c.id);
  assert.ok(!ids.includes(E.id), 'E 标过看过了');
  assert.ok(!ids.includes(A.id), 'A 辞动过');
  const again = hc.buildCandidates();
  assert.ok(!again.candidates.some(c => c.id === A.id), 'A 第二天也不该回来');
  assert.equal(again.candidates[0].id, B.id);
  assert.ok(again.candidates[0].carried, '没处理的顺延');
});

await step('封顶 15 条', () => {
  for (let i = 0; i < 20; i++) {
    const g = grains.addGrain({ category: 'learning', text: `凑数 ${i}` }).grain;
    for (let k = 0; k < 7; k++) grains.touch(g.id, 'read');
    grains.updateGrain(g.id, { heat: 0 });
  }
  const r = hc.buildCandidates();
  assert.equal(r.count, 15); assert.ok(r.dropped_over_cap >= 1);
});

await step('tidy 报告里带 heat_candidates，摘要里有一句', () => {
  const rep = tidy.tidy({ force: true });
  assert.equal(rep.heat_candidates.count, 15);
  assert.ok(rep.heat_candidates.ids.includes(B.id));
  assert.ok(rep.summary.includes('挑了 15 条记忆等你定'), rep.summary);
  assert.ok(rep.heat_candidates.items[0].why);
});

await step('heat_review 视图：不带 ids 带清单；带 ids 就标看过', () => {
  const v = hc.review();
  assert.equal(v.candidate_ids.length, 15);
  assert.ok(v.candidates_note.includes('heat_review'));
  const v2 = hc.review([B.id]);
  assert.deepEqual(v2.reviewed_now, [B.id]);
  assert.ok(!v2.candidate_ids.includes(B.id));
  const w = hc.wakeHint();
  assert.equal(w.count, 14); assert.ok(w.hint.includes('heat_review'));
});

await step('投递：窗口外不投；棋子刚说过话不投；通话中不投', async () => {
  const r1 = await hc.deliverDue({ at: atLocal('01:00'), lastNorAt: null, inCall: false });
  assert.equal(r1.reason, 'outside_window');
  const r1b = await hc.deliverDue({ at: atLocal('11:00'), lastNorAt: null, inCall: false });
  assert.equal(r1b.reason, 'outside_window');
  const t = atLocal('03:00');
  const r2 = await hc.deliverDue({ at: t, lastNorAt: new Date(t.getTime() - 10 * 60000).toISOString(), inCall: false });
  assert.equal(r2.reason, 'nor_active');
  const r3 = await hc.deliverDue({ at: t, lastNorAt: null, inCall: true });
  assert.equal(r3.reason, 'in_call');
  assert.equal(chat.pendingForCy().count, 0, '都不该投');
});

await step('投递：02:30 后、她两小时没说话、没在通话 → 一条系统事件进主要窗口队列，一天只投一次', async () => {
  const t = atLocal('02:30');
  const dry = await hc.deliverDue({ at: t, lastNorAt: new Date(t.getTime() - 2 * 3600000).toISOString(), inCall: false, dryRun: true });
  assert.equal(dry.would_deliver, true);
  const r = await hc.deliverDue({ at: t, lastNorAt: new Date(t.getTime() - 2 * 3600000).toISOString(), inCall: false });
  assert.equal(r.delivered, true, JSON.stringify(r));
  assert.equal(r.count, 14);
  const pending = chat.pendingForCy();
  assert.equal(pending.count, 1);
  const m = pending.messages[0];
  assert.equal(m.sender, 'system'); assert.equal(m.action, 'heat_candidates'); assert.equal(m.deliver_to_cy, true);
  assert.equal(m.source_device, 'muwen_tidy');
  assert.ok(m.text_for_cy.includes('[系统提示]') && m.text_for_cy.includes('14 条') && m.text_for_cy.includes('heat_review'), m.text_for_cy);
  assert.ok(m.content.startsWith('后台挑了 14 条'));
  const again = await hc.deliverDue({ at: atLocal('03:00'), lastNorAt: null, inCall: false });
  assert.equal(again.reason, 'already_delivered_today');
  assert.equal(chat.pendingForCy().count, 1, '不许投第二条');
  assert.equal(hc.deliveryStatus().message_id, m.id);
});

await step('棋子最后说话时间：从木屋聊天里读', async () => {
  assert.equal(chat.lastNorMessageAt(), null);
  await chat.sendMessage({ sender: 'nor', content: '在吗' });
  const at = Date.parse(chat.lastNorMessageAt());
  assert.ok(Date.now() - at < 60000);
  // 默认不注入 lastNorAt 时也会读到她刚说过话（换一天模拟）
  const r = await hc.deliverDue({ at: atLocal('03:00'), inCall: false, today: '2099-01-01' });
  assert.equal(r.reason, 'nor_active');
});

await step('没候选不投', async () => {
  hc.markReviewed(hc.listCandidates().ids);
  // 全标完 → 重新生成也为空：把凑数那批归档
  for (const g of grains.allGrains()) if (g.text.startsWith('凑数') || [C.id, D.id].includes(g.id)) grains.setStatus(g.id, 'archived');
  const r = await hc.deliverDue({ at: atLocal('03:00'), lastNorAt: null, inCall: false, today: '2099-01-02' });
  assert.equal(r.reason, 'no_candidates', JSON.stringify(r));
});

await step('召回次数统计只数 auto、只数窗口内', () => {
  log.appendRecallLog({ id: 'old', auto: true, notice: 'x', returned_ids: [F.id], returned: 1, created_at: '2026-01-01T10:00:00+11:00' });
  const counts = log.returnedCountsSince(14);
  assert.equal(counts.get(A.id), 5);
  assert.equal(counts.get(F.id), 5, '手动 recall 和 14 天外的不算');
});

fs.rmSync(DATA, { recursive: true, force: true });
if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log('\n记忆候选：全部通过');
process.exit(0);
