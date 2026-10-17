import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwen-main-history-'));
process.env.DATA_DIR = dataDir;

const common = await import('../lib/muwen/common.js');
const chat = await import('../lib/muwen/chat.js');
const rings = await import('../lib/muwen/rings.js');
const nursery = await import('../lib/muwen/nursery.js');
const history = await import('../lib/muwen/history.js');

const date = common.todayStr();
const hhmm = common.localISO(new Date()).slice(11, 16);
const muwu = await chat.sendMessage({ sender: 'nor', content: '木屋主聊天唯一句', source_device: 'test' });
rings.addRing({
  window_name: 'Claude主窗口测试', date,
  content: `[${hhmm}] 棋子: Claude主聊天棋子句\n\n[${hhmm}] 辞: Claude主聊天辞句`
});
nursery.sendMessage({ room: 'family', sender: 'nor', content: '婴儿房隔离唯一句' });

const index = history.dates();
assert.equal(index.source, 'main');
assert.deepEqual(index.excludes, ['nursery']);
assert.ok(index.dates[date].muwu >= 1);
assert.ok(index.dates[date].claude >= 1);
assert.equal(index.dates[date].nursery, 0);

const mainDay = history.day({ date });
assert.equal(mainDay.source, 'main');
assert.ok(mainDay.messages.some(message => message.text.includes('木屋主聊天唯一句')));
assert.ok(mainDay.messages.some(message => message.text.includes('Claude主聊天棋子句')));
assert.ok(!mainDay.messages.some(message => message.text.includes('婴儿房隔离唯一句')));
assert.ok(history.day({ date, source: 'all' }).messages.some(message => message.text.includes('婴儿房隔离唯一句')));

const context = history.mainContext({
  hours: 2, recent_hours: 1,
  now_at: new Date(Date.now() + 60_000).toISOString()
});
assert.deepEqual(context.includes, ['muwu', 'claude']);
assert.deepEqual(context.excludes, ['nursery']);
assert.ok(context.messages.some(message => message.id === `muwu:${muwu.id}`));
assert.ok(context.messages.some(message => message.text.includes('Claude主聊天辞句')));
assert.ok(!context.export_text.includes('婴儿房隔离唯一句'));
assert.ok(context.source_segments.some(segment => segment.source === 'muwu'));
assert.ok(context.source_segments.some(segment => segment.source === 'claude' && segment.window_name === 'Claude主窗口测试'));
assert.equal(context.cursor.last_muwu_message_id, muwu.id);

const exported = history.exportDay({ date });
assert.match(exported.content, /\[木屋\]\[棋子\] 木屋主聊天唯一句/);
assert.match(exported.content, /Claude·Claude主窗口测试/);
assert.doesNotMatch(exported.content, /婴儿房隔离唯一句/);

assert.equal(history.search({ query: '婴儿房隔离唯一句' }).total, 0);
assert.ok(history.search({ query: '木屋主聊天唯一句' }).total >= 1);

const daily = rings.addDaily({
  date, headline: '统一主聊天测试',
  source_segments: context.source_segments,
  source_cursor: context.cursor
});
assert.equal(daily.source_scope, 'main');
assert.deepEqual(daily.source_cursor, context.cursor);
assert.ok(daily.source_segments.some(segment => segment.source === 'muwu'));

console.log('✓ 木屋 + Claude 主聊天统一时间线、来源标记、导出与婴儿房隔离');
