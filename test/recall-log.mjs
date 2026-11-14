// 召回日志存储层（lib/muwen/recall-log.js）的单元测试：
//   · 旧的大文件 recall_logs.json 只被读一次尾部，之后不改不写；
//   · 新日志按天 jsonl 追加，不整表重写；
//   · 内存里最近 200 条在滚动，30 分钟压制接得上旧文件；
//   · notice / context_summary 截到 300 字；
//   · getRecallLogs 新→旧，先 jsonl 再旧文件尾部。
// 跑法：node test/recall-log.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muwen-recall-log-'));
process.env.DATA_DIR = DATA;

const legacyPath = path.join(DATA, 'recall_logs.json');
// 造一份旧格式的大文件：1500 条，其中 notice 很长（模拟棋子粘贴的内容）
const legacy = [];
for (let i = 0; i < 1500; i++) {
  legacy.push({
    id: `old${i}`, auto: true, notice: i % 100 === 0 ? 'x'.repeat(5000) : `旧消息 ${i}`,
    returned_ids: i >= 1490 ? [`g_recent_${i}`] : [`g_old_${i}`],
    returned: 1, created_at: i >= 1490 ? new Date(Date.now() - 60000).toISOString() : '2026-09-10T10:00:00+10:00'
  });
}
fs.writeFileSync(legacyPath, JSON.stringify(legacy, null, 2));
const legacyStat = () => { const st = fs.statSync(legacyPath); return `${st.mtimeMs}:${st.size}`; };
const legacyBefore = legacyStat();

const log = await import('../lib/muwen/recall-log.js');
const { recentlySurfaced, SUPPRESS_MINUTES } = await import('../lib/muwen/recall.js');

let failed = 0;
async function step(name, fn) {
  try { await fn(); console.log('✓', name); }
  catch (e) { failed++; console.log('✗', name, '\n  ', e && e.stack || e); }
}

await step('启动：从旧文件尾部接上最近 200 条，旧文件本身不变', () => {
  const recent = log.recentRecallLogs();
  assert.equal(recent.length, 200);
  assert.equal(recent[recent.length - 1].id, 'old1499');
  assert.equal(legacyStat(), legacyBefore, '旧文件不该被改写');
  const stats = log.recallLogStats();
  assert.equal(stats.legacy.exists, true);
  assert.equal(stats.legacy.entries, 1000, '只取尾部 1000 条');
  // 旧文件里 5000 字的 notice 进内存时截短了
  const long = recent.find(e => e.id === 'old1400');
  assert.ok(long && long.notice.length <= 301, `内存里的旧 notice 应被截短：${long && long.notice.length}`);
});

await step('30 分钟压制能接上旧文件里刚浮现过的 id', () => {
  const ids = recentlySurfaced(SUPPRESS_MINUTES);
  assert.ok(ids.has('g_recent_1499'), '一分钟前召回过的要在压制名单里');
  assert.ok(!ids.has('g_old_100'), '九月份的不该在');
});

await step('追加：写进按天 jsonl，截短正文，内存滚动，旧文件不碰', () => {
  const dir = path.join(DATA, 'recall_logs');
  for (let i = 0; i < 250; i++) {
    log.appendRecallLog({
      id: `new${i}`, auto: true, notice: i === 0 ? '新'.repeat(1000) : `新消息 ${i}`,
      context_summary: 'c'.repeat(800), returned_ids: [`g_new_${i}`], returned: 1,
      created_at: `2026-11-14T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}+11:00`
    });
  }
  assert.ok(fs.existsSync(path.join(dir, '2026-11-14.jsonl')), '要有 2026-11-14.jsonl');
  const lines = fs.readFileSync(path.join(dir, '2026-11-14.jsonl'), 'utf-8').trim().split('\n');
  assert.equal(lines.length, 250);
  const first = JSON.parse(lines[0]);
  assert.ok(first.notice.length <= 301 && first.notice.endsWith('…'), `notice 要截到 300 字：${first.notice.length}`);
  assert.ok(first.context_summary.length <= 301, 'context_summary 也要截');
  assert.equal(legacyStat(), legacyBefore, '追加不该碰旧文件');
  const recent = log.recentRecallLogs();
  assert.equal(recent.length, 200, '内存只留 200 条');
  assert.equal(recent[0].id, 'new50');
  assert.equal(recent[199].id, 'new249');
  const ids = recentlySurfaced(SUPPRESS_MINUTES);
  assert.ok(!ids.has('g_recent_1499'), '被挤出 200 条窗口的不再压制（跟以前 slice(-200) 一致）');
});

await step('跨天：按 created_at 落到对应日期的文件', () => {
  log.appendRecallLog({ id: 'yday', auto: true, notice: '昨天', returned_ids: [], returned: 0, created_at: '2026-11-13T23:59:00+11:00' });
  assert.ok(fs.existsSync(path.join(DATA, 'recall_logs', '2026-11-13.jsonl')));
});

await step('getRecallLogs：新→旧，先 jsonl 再旧文件尾部，结构不变', () => {
  const top = log.getRecallLogs(3);
  assert.equal(top.length, 3);
  assert.equal(top[0].id, 'new249');
  assert.equal(top[2].id, 'new247');
  const all = log.getRecallLogs(300);
  assert.equal(all.length, 300);
  assert.equal(all[250].id, 'yday', '昨天那条排在今天 250 条之后');
  assert.equal(all[251].id, 'old1499', '再往后接旧文件尾部');
  const huge = log.getRecallLogs(100000);
  assert.equal(huge.length, 251 + 1000, '旧文件只给尾部 1000 条，更早的不读');
  assert.equal(legacyStat(), legacyBefore);
});

await step('重启：内存从 jsonl 恢复，不够 200 才读旧文件', () => {
  log._resetForTests();
  const t0 = Date.now();
  const recent = log.recentRecallLogs();
  assert.equal(recent.length, 200);
  assert.equal(recent[199].id, 'new249');
  assert.equal(log.recallLogStats().legacy.loaded, false, 'jsonl 够 200 条时不该去读旧文件');
  assert.ok(Date.now() - t0 < 2000);
});

await step('坏行：写到一半的 jsonl 行被跳过', () => {
  fs.appendFileSync(path.join(DATA, 'recall_logs', '2026-11-14.jsonl'), '{"id":"half","notice":"写到一');
  const top = log.getRecallLogs(1);
  assert.equal(top[0].id, 'new249');
});

await step('只读模式不写日志', async () => {
  const { runReadonly } = await import('../lib/muwen/readonly.js');
  const before = fs.statSync(path.join(DATA, 'recall_logs', '2026-11-14.jsonl')).size;
  await runReadonly(() => log.appendRecallLog({ id: 'ro', notice: 'x', created_at: '2026-11-14T12:00:00+11:00' }));
  assert.equal(fs.statSync(path.join(DATA, 'recall_logs', '2026-11-14.jsonl')).size, before);
});

await step('没有旧文件也能跑', () => {
  const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'muwen-recall-log2-'));
  // 换目录要重新 import 不方便；这里只验证 loadLegacyTail 对不存在的文件安全
  log._resetForTests();
  fs.renameSync(legacyPath, legacyPath + '.moved');
  try {
    assert.deepEqual(log.loadLegacyTail(), []);
    assert.equal(log.recallLogStats().legacy.exists, false);
  } finally { fs.renameSync(legacyPath + '.moved', legacyPath); log._resetForTests(); }
  fs.rmSync(DATA2, { recursive: true, force: true });
});

fs.rmSync(DATA, { recursive: true, force: true });
if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log('\n召回日志存储层：全部通过');
