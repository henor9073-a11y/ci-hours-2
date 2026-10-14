import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.SUPABASE_BACKUP_BUCKET = 'private-test-backups';

const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), method: options.method || 'GET', headers: options.headers, body: options.body });
  if (String(url).endsWith('/storage/v1/bucket/private-test-backups')) {
    return new Response(JSON.stringify({ message: 'not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (String(url).endsWith('/storage/v1/bucket')) {
    return new Response(JSON.stringify({ name: 'private-test-backups' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (String(url).includes('/storage/v1/object/private-test-backups/ci-hours/')) {
    return new Response(JSON.stringify({ Key: 'ok' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
  throw new Error(`unexpected fetch: ${url}`);
};

const { uploadCiHoursBackup } = await import(`../lib/backup-storage.js?test=${Date.now()}`);
const filename = 'ci-hours-backup-2026-10-14-1200.json.gz';
const result = await uploadCiHoursBackup({ filename, buffer: Buffer.from('gzip-test') });

assert.equal(result.ok, true);
assert.equal(result.private, true);
assert.equal(result.bucket, 'private-test-backups');
assert.equal(result.object_path, `ci-hours/${filename}`);
assert.equal(result.bucket_created, true);
assert.equal(calls[1].method, 'POST');
assert.deepEqual(JSON.parse(calls[1].body), {
  id: 'private-test-backups', name: 'private-test-backups', public: false
});
assert.equal(calls[2].headers['x-upsert'], 'true');
assert.equal(calls[2].headers.Authorization, 'Bearer test-service-key');

await assert.rejects(
  uploadCiHoursBackup({ filename: '../bad.json.gz', buffer: Buffer.from('x') }),
  /固定格式/
);

console.log('✓ Supabase 私有备份桶创建、上传和文件名防护');
