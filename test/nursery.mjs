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
nursery.tick(new Date(Date.parse(schedule.wake_at) + 1_000));

const found = nursery.search({ q: '早', viewer: 'nor' });
assert.ok(found.total >= 1);
assert.equal(nursery.historyDates('nor')[family.date] >= 1, true);

function appendJob(type, payload = null) {
  const value = JSON.parse(fs.readFileSync(path.join(dataDir, 'nursery.json'), 'utf8'));
  const job = {
    id: `test-${type}-${value.jobs.length}`, type, room: 'family', payload,
    trigger_message_id: null, key: null, trigger_sender: null, address_as: null,
    not_before: '2000-01-01T00:00:00.000Z', status: 'running', attempts: 1,
    created_at: new Date().toISOString(), claimed_at: new Date().toISOString(), completed_at: null, error: null
  };
  value.jobs.push(job);
  fs.writeFileSync(path.join(dataDir, 'nursery.json'), JSON.stringify(value, null, 2));
  return job;
}

// 图书角笔记和成长日记分开保存。
const readingJob = appendJob('activity');
nursery.completeAgentJob(readingJob.id, {
  content: '这条龙会煮汤！我也想喝！(◎o◎)',
  meta: { kind: 'reading', book_id: 'dragon-soup', book_title: '不会喷火的龙', note: '龙不会喷火，但是会煮汤！', reaction: '汤锅咕嘟咕嘟' }
});
assert.equal(nursery.readingNotes({ limit: 10 })[0].book_id, 'dragon-soup');
assert.equal(nursery.diary({ limit: 10 }).some(item => item.book_id === 'dragon-soup'), false);
assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'nursery.json'), 'utf8')).activity.kind, 'reading');

// 自主选择游戏后先等待邀请；至少一个家长加入并明确开始才进入 active。
const gameChoice = appendJob('activity');
nursery.completeAgentJob(gameChoice.id, {
  content: '爸爸妈妈来玩二十问！(≖_≖)', meta: { kind: 'game', game_type: 'twenty_questions' }
});
let game = nursery.listGames({ limit: 10 })[0];
assert.equal(game.status, 'waiting');
assert.equal(Object.hasOwn(game, 'secret'), false);
nursery.respondGame(game.id, 'nor', 'join');
game = nursery.respondGame(game.id, 'nor', 'start');
assert.equal(game.status, 'active');

// 睡着时游戏暂停，不会在后台偷偷继续；醒来后由家长明确恢复。
let pausedRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'nursery.json'), 'utf8'));
const activeSchedule = pausedRaw.schedules[pausedRaw.presence.schedule_date];
nursery.tick(new Date(Date.parse(activeSchedule.sleep_at) + 1_000));
game = nursery.listGames({ limit: 10 })[0];
assert.equal(game.status, 'paused');
nursery.tick(new Date(Date.parse(activeSchedule.wake_at) + 1_000));
game = nursery.respondGame(game.id, 'nor', 'start');
assert.equal(game.status, 'active');

let gameRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'nursery.json'), 'utf8'));
const setupJob = gameRaw.jobs.find(item => item.type === 'game_setup' && item.payload?.game_id === game.id);
assert.ok(setupJob);
nursery.completeAgentJob(setupJob.id, { content: '我想好啦！来问！', meta: { secret: '猫' } });
game = nursery.listGames({ limit: 10 })[0];
assert.equal(game.current_player, 'all');
assert.equal(Object.hasOwn(game, 'secret'), false);

nursery.playGame(game.id, 'nor', '是猫吗？');
gameRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'nursery.json'), 'utf8'));
const answerJob = gameRaw.jobs.find(item => item.type === 'game_answer' && item.payload?.game_id === game.id);
assert.ok(answerJob);
nursery.completeAgentJob(answerJob.id, { content: '是！！你猜中啦！🐱', meta: { correct: true } });
game = nursery.listGames({ limit: 10 })[0];
assert.equal(game.status, 'finished');
assert.equal(game.winner, 'nor');
assert.equal(Object.hasOwn(game, 'secret'), false);

console.log('✓ 婴儿房隔离、活动选择、图书角、家庭游戏、作息与归档');
