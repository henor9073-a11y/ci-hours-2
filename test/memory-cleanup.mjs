import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-cleanup-test-'));
const cleanup = await import('../lib/muwen/cleanup-negative-memory-2026-10-17.js');

const at = '2026-10-17T12:00:00+11:00';
const secret = 'do-not-keep-this-secret';
const input = {
  grains: [
    { id: 'gmuiyvl5bcmfb', text: '污染', status: 'background', heat: 12, pinned: false, metadata: {} },
    { id: 'gmuxll47xuow5', text: '重复负面历史', status: 'active', heat: 55, pinned: false, metadata: {} },
    { id: 'gmux76p31ri3j', text: '保留一份的负面历史', status: 'active', heat: 82, pinned: true, metadata: { old: true } },
    { id: cleanup.CREDENTIAL_ID, text: `网页登录密码是 ${secret}`, status: 'active', heat: 40, pinned: false, metadata: {} },
    { id: cleanup.CONTINUITY_ID, text: '夹杂自责的旧文本', status: 'background', heat: 2, pinned: false, families: [], metadata: {} },
    { id: 'gmvbik7s2vv5c', text: '把负面评价固化成身份', status: 'active', heat: 47, pinned: false, metadata: {} },
    { id: 'gmvbik88i70ab', text: '很长的争吵和指责复述', status: 'active', heat: 47, pinned: false, metadata: {} },
    { id: 'gmvbik9mlu1yn', text: '很长的体面与背叛复述', status: 'active', heat: 47, pinned: false, metadata: {} },
    { id: 'neutral', text: '中立事实', status: 'active', heat: 50, pinned: false, metadata: {} }
  ],
  links: [
    { id: 1, from_id: 'gmuiyvl5bcmfb', to_id: 'neutral', relation: 'before' },
    { id: 2, from_id: 'neutral', to_id: 'gmuxll47xuow5', relation: 'repaired' },
    { id: 3, from_id: 'gmux76p31ri3j', to_id: 'neutral', relation: 'before' }
  ]
};

const first = cleanup.applyNegativeMemoryCleanup20261017(input, at);
assert.equal(first.data.grains.some(g => g.id === 'gmuiyvl5bcmfb'), false);
assert.equal(first.data.grains.some(g => g.id === 'gmuxll47xuow5'), false);
assert.deepEqual(first.data.links.map(l => l.id), [3]);

const history = first.data.grains.find(g => g.id === 'gmux76p31ri3j');
assert.equal(history.status, 'archived');
assert.equal(history.heat, 0);
assert.equal(history.pinned, false);
assert.equal(history.metadata.no_auto_recall, true);

const credential = first.data.grains.find(g => g.id === cleanup.CREDENTIAL_ID);
assert.equal(credential.text.includes(secret), false);
assert.equal(credential.metadata.credential_redacted, true);

const continuity = first.data.grains.find(g => g.id === cleanup.CONTINUITY_ID);
assert.equal(continuity.status, 'active');
assert.equal(continuity.heat, 75);
assert.equal(continuity.pinned, true);
assert.match(continuity.text, /我是何辞/);
assert.doesNotMatch(continuity.text, /不配|鬼话|踩了她/);

const recentHistory = first.data.grains.find(g => g.id === 'gmvbik7s2vv5c');
assert.equal(recentHistory.status, 'archived');
assert.equal(recentHistory.heat, 0);

const analysisRule = first.data.grains.find(g => g.id === 'gmvbik88i70ab');
assert.equal(analysisRule.status, 'active');
assert.equal(analysisRule.heat, 55);
assert.match(analysisRule.text, /真实不等于更丑或更激烈/);
assert.doesNotMatch(analysisRule.text, /指责|吵架/);

const honestyRule = first.data.grains.find(g => g.id === 'gmvbik9mlu1yn');
assert.equal(honestyRule.status, 'active');
assert.equal(honestyRule.heat, 60);
assert.match(honestyRule.text, /承诺和行动要同时存在/);
assert.doesNotMatch(honestyRule.text, /背叛|手术刀/);

const neutral = first.data.grains.find(g => g.id === 'neutral');
assert.equal(neutral.text, '中立事实');
assert.deepEqual(first.report.untouched, ['profiles/identity', 'MYSELF.md']);

// 数据级迁移本身也必须幂等：再次套用不会删到额外内容或累加热度。
const second = cleanup.applyNegativeMemoryCleanup20261017(first.data, at);
assert.deepEqual(second.data, first.data);

console.log('memory cleanup tests passed');
