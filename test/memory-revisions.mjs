import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwen-memory-revisions-'));
process.env.DATA_DIR = dataDir;

const grains = await import('../lib/muwen/grains.js');
const revisions = await import('../lib/muwen/memory-revisions.js');

const original = grains.addGrain({ category: 'agreement', text: '旧版本：周末一起散步。', families: ['生活'] }).grain;
const proposal = revisions.createProposal({
  grain_id: original.id,
  proposed_text: '新版本：天气合适时，周末一起散步。',
  reason: '不是每个周末都必须出门'
});
assert.equal(proposal.status, 'pending');
assert.equal(revisions.counts().open, 1);
assert.throws(() => revisions.createProposal({ grain_id: original.id, proposed_text: '重复提案' }), /已经有一份/);

const counter = revisions.decideProposal(proposal.id, {
  action: 'counter', content: '辞的版本：有精神、天气合适时，周末一起散步。', note: '加上体力条件', actor: 'cy'
});
assert.equal(counter.status, 'discussing');
assert.match(counter.proposed_text, /有精神/);

const applied = revisions.decideProposal(proposal.id, { action: 'approve', note: '就按这个', actor: 'cy' });
assert.equal(applied.status, 'applied');
assert.ok(applied.applied_grain_id);
assert.equal(grains.getGrain(original.id, { touchIt: false }).status, 'archived');
const v2 = grains.getGrain(applied.applied_grain_id, { touchIt: false });
assert.equal(v2.status, 'active');
assert.match(v2.text, /有精神/);
assert.equal(v2.metadata.revised_from, original.id);
assert.ok(grains.getLinks(v2.id).some(link => link.relation === 'supersedes' && link.to_id === original.id));

const rollback = revisions.requestRollback(proposal.id, { reason: '还是想恢复原来的说法' });
assert.equal(rollback.kind, 'rollback');
assert.equal(rollback.proposed_text, original.text);
const rolled = revisions.decideProposal(rollback.id, { action: 'approve', actor: 'cy' });
const v3 = grains.getGrain(rolled.applied_grain_id, { touchIt: false });
assert.equal(v3.text, original.text);
assert.equal(grains.getGrain(v2.id, { touchIt: false }).status, 'archived');

const staleBase = grains.addGrain({ category: 'learning', text: '先写一个版本。' }).grain;
const staleProposal = revisions.createProposal({ grain_id: staleBase.id, proposed_text: '建议版本。' });
grains.updateGrain(staleBase.id, { text: '外部已经改过。' });
assert.throws(() => revisions.decideProposal(staleProposal.id, { action: 'approve', actor: 'cy' }), /发生了变化/);
assert.equal(revisions.getProposal(staleProposal.id).stale, true);
const withdrawn = revisions.withdrawProposal(staleProposal.id, { note: '按新内容重提' });
assert.equal(withdrawn.status, 'withdrawn');

const rejectedBase = grains.addGrain({ category: 'feeling', text: '原来的感受。' }).grain;
const rejectedProposal = revisions.createProposal({ grain_id: rejectedBase.id, proposed_text: '建议改的感受。' });
const rejected = revisions.decideProposal(rejectedProposal.id, { action: 'reject', note: '原文更准确', actor: 'cy' });
assert.equal(rejected.status, 'rejected');
assert.equal(grains.getGrain(rejectedBase.id, { touchIt: false }).text, '原来的感受。');

console.log('✓ 记忆修改提案、辞审议、版本替换、归档、撤销建议与并发保护');
