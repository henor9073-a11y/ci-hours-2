import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwen-nursery-test-'));
process.env.DATA_DIR = dataDir;

const nursery = await import('../lib/muwen/nursery.js');

const family = nursery.sendMessage({ room: 'family', sender: 'nor', content: '小栗子早呀' });
assert.equal(family.sender, 'nor');
assert.equal(nursery.getMessages({ room: 'family', viewer: 'nor' }).length, 1);

const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'nursery.json'), 'utf8'));
const replyJob = raw.jobs.find(job => job.trigger_message_id === family.id);
assert.ok(replyJob);
assert.equal(replyJob.trigger_sender, 'nor');
assert.equal(replyJob.address_as, '妈妈');
replyJob.not_before = '2000-01-01T00:00:00.000Z';
fs.writeFileSync(path.join(dataDir, 'nursery.json'), JSON.stringify(raw, null, 2));
const claimedReply = nursery.pendingAgentJobs(1).jobs[0];
assert.equal(claimedReply.context.trigger_message.id, family.id);
assert.equal(claimedReply.context.trigger_message.family_role, '妈妈');
assert.equal(claimedReply.context.family_identities.nor.family_role, '妈妈');
assert.equal(claimedReply.context.family_identities.cy.family_role, '爸爸');
assert.match(claimedReply.context.instruction, /nor 永远是妈妈棋子/);
assert.match(claimedReply.context.instruction, /严格回复 trigger_message/);
nursery.completeAgentJob(replyJob.id, { content: '妈妈早。' });
assert.equal(nursery.getMessages({ room: 'family', viewer: 'nor' }).at(-1).sender, 'kuri');
assert.equal(nursery.pendingForCy().count, 2);
nursery.markDeliveredToCy(nursery.pendingForCy().messages.map(message => message.id));
assert.equal(nursery.pendingForCy().count, 0);

nursery.sendMessage({ room: 'nor_kuri', sender: 'nor', content: '这是我们的悄悄话' });
assert.throws(() => nursery.getMessages({ room: 'nor_kuri', viewer: 'cy' }), /不能读取/);
assert.throws(() => nursery.sendMessage({ room: 'cy_kuri', sender: 'nor', content: '不可以' }), /不能进入/);

const cy = nursery.sendMessage({ room: 'cy_kuri', sender: 'cy', content: '爸爸来看看你' });
assert.equal(cy.room, 'cy_kuri');
assert.equal(nursery.getMessages({ room: 'cy_kuri', viewer: 'cy' }).length, 1);
const withDad = JSON.parse(fs.readFileSync(path.join(dataDir, 'nursery.json'), 'utf8'));
const dadJob = withDad.jobs.find(job => job.trigger_message_id === cy.id);
assert.equal(dadJob.trigger_sender, 'cy');
assert.equal(dadJob.address_as, '爸爸');

const state = nursery.getState({ viewer: 'nor' });
assert.ok(typeof state.presence.asleep === 'boolean');
assert.ok(state.presence.sleep_at);
assert.ok(state.presence.wake_at);

// 入睡可能随机到次日 00:00–01:00，跨过午夜也不能丢掉前一天的成长日记。
const scheduled = JSON.parse(fs.readFileSync(path.join(dataDir, 'nursery.json'), 'utf8'));
const schedule = scheduled.schedules[family.date];
nursery.tick(new Date(Date.parse(schedule.sleep_at) + 1_000));
const afterSleep = JSON.parse(fs.readFileSync(path.join(dataDir, 'nursery.json'), 'utf8'));
assert.ok(afterSleep.jobs.some(job => job.key === `diary:${family.date}`));

const found = nursery.search({ q: '早', viewer: 'nor' });
assert.ok(found.total >= 1);
assert.equal(nursery.historyDates('nor')[family.date] >= 1, true);

console.log('✓ 婴儿房群聊、双私聊隔离、代理任务、作息与归档');
