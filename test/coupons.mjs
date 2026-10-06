import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'muwen-coupons-'));
process.env.DATA_DIR = data;

const coupons = await import('../lib/muwen/coupons.js');

const forCy = await coupons.createCoupon({ actor: 'nor', title: '抱抱', emoji: '🫂', description: '现在来抱一下', validity: 'one_week' });
assert.equal(forCy.holder, 'cy');
assert.equal(forCy.target, 'nor');
await assert.rejects(coupons.useCoupon(forCy.id, 'nor'), /持券/);
assert.equal((await coupons.useCoupon(forCy.id, 'cy')).status, 'used');

const forNor = await coupons.createCoupon({ actor: 'cy', title: '散步', emoji: '🌙', description: '陪你出去走走', validity: 'permanent' });
assert.equal(forNor.holder, 'nor');
assert.equal(forNor.expires_at, null);
let pending = await coupons.requestRevocation(forNor.id, 'cy');
assert.equal(pending.status, 'available');
assert.equal(pending.revocation_pending, true);
const revoked = await coupons.requestRevocation(forNor.id, 'nor');
assert.equal(revoked.status, 'revoked');

const past = coupons.listCoupons().filter(item => item.status !== 'available');
assert.deepEqual(new Set(past.map(item => item.status)), new Set(['used', 'revoked']));
console.log('✓ coupon direction, use, and mutual revocation');
