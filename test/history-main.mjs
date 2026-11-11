import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwen-main-history-'));
process.env.DATA_DIR = dataDir;

const common = await import('../lib/muwen/common.js');
const chat = await import('../lib/muwen/chat.js');
const calls = await import('../lib/muwen/calls.js');
const rings = await import('../lib/muwen/rings.js');
const nursery = await import('../lib/muwen/nursery.js');
const history = await import('../lib/muwen/history.js');

const date = common.todayStr();
const hhmm = common.localISO(new Date()).slice(11, 16);
const muwu = await chat.sendMessage({ sender: 'nor', content: '木屋主聊天唯一句', source_device: 'test' });
const owner = { session_id: '11111111-1111-4111-8111-111111111111', window_name: '电话窗口', model: 'claude-opus-4-6[1m]', model_label: 'Opus 4.6 · 1M', is_primary: true };
const call = calls.start('nor', { owner, initiatedVia: 'user_ui' });
calls.action('cy', 'accept', { sessionId: owner.session_id });
const callNor = calls.say('nor', '电话里棋子唯一句');
const callCy = calls.say('cy', '电话里辞唯一句', 'voice', { sessionId: owner.session_id });
calls.action('cy', 'hangup', { sessionId: owner.session_id });
rings.addRing({
  window_name: 'Claude主窗口测试', date,
  content: `[${hhmm}] 棋子: Claude主聊天棋子句\n\n[${hhmm}] 辞: Claude主聊天辞句`
});
nursery.sendMessage({ room: 'family', sender: 'nor', content: '婴儿房隔离唯一句' });

const index = history.dates();
assert.equal(index.source, 'main');
assert.deepEqual(index.excludes, ['nursery']);
assert.ok(index.dates[date].muwu >= 1);
assert.equal(index.dates[date].call, 2);
assert.ok(index.dates[date].claude >= 1);
assert.equal(index.dates[date].nursery, 0);
// 日期索引按来源文件 mtime 缓存：文件没变就复用，一写入就失效
assert.deepEqual(history.dates(), index);
await chat.sendMessage({ sender: 'nor', content: '让日期索引缓存失效的第二句', source_device: 'test' });
assert.equal(history.dates().dates[date].muwu, index.dates[date].muwu + 1);
assert.equal(index.dates[date].muwu + 1, history.dates().dates[date].muwu, '返回的是新对象，旧结果不被改动');

const mainDay = history.day({ date });
assert.equal(mainDay.source, 'main');
assert.ok(mainDay.messages.some(message => message.text.includes('木屋主聊天唯一句')));
assert.ok(mainDay.messages.some(message => message.id === `call:${callNor.id}` && message.text === '电话里棋子唯一句'));
assert.ok(mainDay.messages.some(message => message.id === `call:${callCy.id}` && message.text === '电话里辞唯一句'));
assert.ok(mainDay.messages.some(message => message.text.includes('Claude主聊天棋子句')));
assert.ok(!mainDay.messages.some(message => message.text.includes('婴儿房隔离唯一句')));
assert.ok(history.day({ date, source: 'all' }).messages.some(message => message.text.includes('婴儿房隔离唯一句')));

const context = history.mainContext({
  hours: 2, recent_hours: 1,
  now_at: new Date(Date.now() + 60_000).toISOString()
});
assert.deepEqual(context.includes, ['muwu', 'call', 'claude']);
assert.deepEqual(context.excludes, ['nursery']);
assert.ok(context.messages.some(message => message.id === `muwu:${muwu.id}`));
assert.ok(context.messages.some(message => message.id === `call:${callNor.id}`));
assert.ok(context.messages.some(message => message.text.includes('Claude主聊天辞句')));
assert.ok(!context.export_text.includes('婴儿房隔离唯一句'));
assert.ok(context.source_segments.some(segment => segment.source === 'muwu'));
assert.ok(context.source_segments.some(segment => segment.source === 'call' && segment.label.includes('木屋电话·电话窗口·Opus 4.6')));
assert.ok(context.source_segments.some(segment => segment.source === 'claude' && segment.window_name === 'Claude主窗口测试'));
assert.ok(context.cursor.last_muwu_message_id);
assert.ok([callNor.id, callCy.id].includes(context.cursor.last_call_event_id));

const exported = history.exportDay({ date });
assert.match(exported.content, /\[木屋\]\[棋子\] 木屋主聊天唯一句/);
assert.match(exported.content, /\[木屋电话·电话窗口·Opus 4\.6 · 1M\]\[棋子\] 电话里棋子唯一句/);
assert.match(exported.content, /\[木屋电话·电话窗口·Opus 4\.6 · 1M\]\[辞\] 电话里辞唯一句/);
assert.match(exported.content, /Claude·Claude主窗口测试/);
assert.doesNotMatch(exported.content, /婴儿房隔离唯一句/);

assert.equal(history.search({ query: '婴儿房隔离唯一句' }).total, 0);
assert.ok(history.search({ query: '木屋主聊天唯一句' }).total >= 1);
assert.ok(history.search({ query: '电话里棋子唯一句' }).hits.some(hit => hit.source === 'call'));
const allSearch = history.search({ query: '唯一句', source: 'all' });
assert.ok(allSearch.hits.some(hit => hit.source === 'muwu'));
assert.ok(history.search({ query: '电话里辞唯一句', source: 'call' }).hits.some(hit => hit.target_id === `call:${callCy.id}`));
assert.ok(allSearch.hits.some(hit => hit.source === 'nursery'));
for (const hit of allSearch.hits) {
  for (const key of ['id', 'target_id', 'source', 'date', 'at', 'sender', 'before', 'match', 'after']) {
    assert.equal(typeof hit[key], 'string', `search hit ${key} 必须稳定返回字符串`);
  }
}

for (let index = 0; index < 125; index++) {
  await chat.sendMessage({ sender: index % 2 ? 'cy' : 'nor', content: `分页测试共同词 ${String(index).padStart(3, '0')}`, source_device: 'test' });
}
const firstSearchPage = history.search({ query: '分页测试共同词', source: 'muwu', limit: 60 });
const secondSearchPage = history.search({ query: '分页测试共同词', source: 'muwu', limit: 60, skip: 60 });
const lastSearchPage = history.search({ query: '分页测试共同词', source: 'muwu', limit: 60, skip: 120 });
assert.equal(firstSearchPage.total, 125);
assert.equal(firstSearchPage.hits.length, 60);
assert.equal(secondSearchPage.hits.length, 60);
assert.equal(lastSearchPage.hits.length, 5);
assert.equal(new Set([...firstSearchPage.hits, ...secondSearchPage.hits, ...lastSearchPage.hits].map(hit => hit.id)).size, 125);

const daily = rings.addDaily({
  date, headline: '统一主聊天测试',
  source_segments: context.source_segments,
  source_cursor: context.cursor
});
assert.equal(daily.source_scope, 'main');
assert.deepEqual(daily.source_cursor, context.cursor);
assert.ok(daily.source_segments.some(segment => segment.source === 'muwu'));
const pipeline = rings.dailyPipelineStatus();
assert.equal(pipeline.status, 'verified');
assert.equal(pipeline.state, 'on');
assert.deepEqual(pipeline.excluded_sources, ['nursery']);
assert.ok(pipeline.sources.includes('muwu'));
assert.ok(pipeline.sources.includes('call'));

console.log('✓ 木屋 + 电话转写 + Claude 主聊天统一时间线、来源标记、每日流水线核验、导出与婴儿房隔离');
