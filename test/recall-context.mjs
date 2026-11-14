// 召回看上下文（lib/muwen/recall.js，2026-11-14）：
//   · contextLines / contextAnchors：从钩子传来的最近几句里取锚点；
//   · sameTopicRecently：还在聊刚召回过的话题 → 跳过；问历史、换题不跳；
//   · autoRecall(autoMode)：查询角度多一条"当前句 + 上文锚点"，日志记 skipped: same_topic。
// 跑法：node test/recall-context.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muwen-recall-ctx-'));
process.env.DATA_DIR = DATA;

const grains = await import('../lib/muwen/grains.js');
const log = await import('../lib/muwen/recall-log.js');
const recall = await import('../lib/muwen/recall.js');

let failed = 0;
async function step(name, fn) {
  try { await fn(); console.log('✓', name); }
  catch (e) { failed++; console.log('✗', name, '\n  ', e && e.stack || e); }
}

const A = grains.addGrain({ category: 'experience', text: '摆摊那天男朋友拿吸尘器打断她打电话，她委屈了很久，后来在天台哭了一场', date: '2026-07-20', families: ['摆摊'] }).grain;
grains.addGrain({ category: 'learning', text: '她说过做作业的时候会很暴躁，这时候别讲道理，陪着就行', date: '2026-10-28', families: ['作业'] });
const ctx = '棋子: 今天又去摆摊了\n辞: 累不累？上次摆摊那天后来还哭了\n棋子: 今天没哭，就是脚酸';

await step('contextLines / contextAnchors：去前缀、取最近几句、挑出锚点（含家族标签）', () => {
  const lines = recall.contextLines(ctx);
  assert.deepEqual(lines, ['今天又去摆摊了', '累不累？上次摆摊那天后来还哭了', '今天没哭，就是脚酸']);
  const anchors = recall.contextAnchors(ctx);
  assert.ok(anchors.includes('摆摊'), JSON.stringify(anchors));
  assert.deepEqual(recall.contextAnchors(''), []);
});

await step('sameTopicRecently：同话题 + 30 分钟内召回过 → true；没召回过 / 换题 / 问历史 → false', () => {
  const q = '摆摊的时候脚酸得不行';
  assert.equal(recall.sameTopicRecently(q, ctx), false, '还没为这个话题召回过');
  log.appendRecallLog({ id: 'ar1', auto: true, notice: '今天又去摆摊了', returned: 1, returned_ids: [A.id], created_at: new Date(Date.now() - 5 * 60000).toISOString() });
  assert.equal(recall.sameTopicRecently(q, ctx), true, '刚为"摆摊"召回过，还在聊摆摊');
  assert.equal(recall.sameTopicRecently(q, ctx, { askedHistory: true }), false, '问历史不跳');
  assert.equal(recall.sameTopicRecently('小栗子今天在家庭群里说了什么新鲜事', ctx), false, '换题了不跳');
  assert.equal(recall.sameTopicRecently(q, ''), false, '没有上文不跳');
  assert.equal(recall.sameTopicRecently(q, ctx, { now: Date.now() + 40 * 60000 }), false, '40 分钟后那次召回已过期');
});

await step('autoRecall(autoMode)：同话题跳过并记日志；非 autoMode（辞自己调工具）不跳', async () => {
  const r = await recall.autoRecall('摆摊的时候脚酸得不行', { autoMode: true, context: ctx, useAgent: false });
  assert.equal(r.skipped, 'same_topic');
  assert.deepEqual(r.memories, []);
  const latest = log.getRecallLogs(1)[0];
  assert.equal(latest.skipped, 'same_topic');
  const r2 = await recall.autoRecall('摆摊的时候脚酸得不行', { autoMode: false, context: ctx, useAgent: false });
  assert.equal(r2.skipped, undefined);
});

await step('autoRecall(autoMode)：换题的话照常召回，查询角度多一条"当前句 + 上文锚点"', async () => {
  const ctx2 = '棋子: 明天要交作业了\n辞: 那你今晚别熬太晚\n棋子: 嗯';
  const r = await recall.autoRecall('我现在特别暴躁别惹我，今天作业做不完', { autoMode: true, context: ctx2, useAgent: false, suppressRecent: false });
  assert.equal(r.skipped, undefined);
  assert.ok(r.angles.length >= 1 && r.angles[0] === '我现在特别暴躁别惹我，今天作业做不完');
  // 上文里的锚点"作业"已经在当前句里了，就不重复组；换个上文验证会组
  const r3 = await recall.autoRecall('我现在特别暴躁别惹我，烦得想砸东西', { autoMode: true, context: ctx2, useAgent: false, suppressRecent: false });
  assert.ok(r3.angles.some(a => a.includes('作业')), JSON.stringify(r3.angles));
  // 只共一个"暴躁"+ 上文的"作业"，关键词分过不了相关性下限 22 是对的（宁可空手）；
  // 上文锚点的作用主要在多角度合并加分和语义层的合成向量上，这里只验证角度组对了。
  const latest = log.getRecallLogs(1)[0];
  assert.ok(latest.context && latest.context.lines === 3 && latest.context.anchors.includes('作业'), JSON.stringify(latest.context));
});

await step('问历史口吻：不组上文角度、不加权', async () => {
  const r = await recall.autoRecall('上次摆摊那天后来怎么样了', { autoMode: true, context: '棋子: 小栗子今天很开心\n辞: 是啊', useAgent: false, suppressRecent: false });
  assert.equal(r.intent, 'answer');
  assert.equal(r.angles.length, 1, JSON.stringify(r.angles));
});

fs.rmSync(DATA, { recursive: true, force: true });
if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log('\n召回看上下文：全部通过');
process.exit(0);
