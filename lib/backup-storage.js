const DEFAULT_BUCKET = 'ci-hours-backups';

function config() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  const bucket = process.env.SUPABASE_BACKUP_BUCKET || DEFAULT_BUCKET;
  return { url, key, bucket };
}

function headers(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...extra
  };
}

async function responseError(response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body.message || body.error || body.statusCode || '';
  } catch {
    try { detail = await response.text(); } catch { detail = ''; }
  }
  return `Supabase Storage HTTP ${response.status}${detail ? ` · ${String(detail).slice(0, 180)}` : ''}`;
}

function objectUrl(url, bucket, objectPath) {
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/');
  return `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${encoded}`;
}

export function backupStorageConfig() {
  const { url, key, bucket } = config();
  return { configured: !!(url && key), bucket };
}

export async function ensureBackupBucket() {
  const { url, key, bucket } = config();
  if (!url || !key) throw new Error('Render 尚未配置 Supabase 服务凭据');

  const existing = await fetch(`${url}/storage/v1/bucket/${encodeURIComponent(bucket)}`, {
    headers: headers(key),
    signal: AbortSignal.timeout(15_000)
  });
  if (existing.ok) return { bucket, created: false };
  if (existing.status !== 404) throw new Error(await responseError(existing));

  const created = await fetch(`${url}/storage/v1/bucket`, {
    method: 'POST',
    headers: headers(key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: bucket, name: bucket, public: false }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!created.ok && created.status !== 409) throw new Error(await responseError(created));
  return { bucket, created: created.ok };
}

export async function uploadCiHoursBackup({ filename, buffer }) {
  if (!/^ci-hours-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json\.gz$/.test(filename || '')) {
    throw new Error('备份文件名不符合固定格式');
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('备份文件为空');
  if (buffer.length > 40 * 1024 * 1024) throw new Error('ci-hours 备份超过 40 MB，已拒绝上传');

  const { url, key, bucket } = config();
  const ensured = await ensureBackupBucket();
  const objectPath = `ci-hours/${filename}`;
  const response = await fetch(objectUrl(url, bucket, objectPath), {
    method: 'POST',
    headers: headers(key, {
      'Content-Type': 'application/gzip',
      'Cache-Control': 'no-store',
      'x-upsert': 'true'
    }),
    body: buffer,
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(await responseError(response));
  return {
    ok: true,
    bucket,
    private: true,
    object_path: objectPath,
    bytes: buffer.length,
    bucket_created: ensured.created
  };
}

export async function listCiHoursBackups(limit = 30) {
  const { url, key, bucket } = config();
  if (!url || !key) return { configured: false, bucket, backups: [] };
  const response = await fetch(`${url}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
    method: 'POST',
    headers: headers(key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      prefix: 'ci-hours',
      limit: Math.max(1, Math.min(Number(limit) || 30, 100)),
      offset: 0,
      sortBy: { column: 'created_at', order: 'desc' }
    }),
    signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 404) return { configured: true, bucket, backups: [] };
  if (!response.ok) throw new Error(await responseError(response));
  const rows = await response.json();
  return {
    configured: true,
    bucket,
    private: true,
    backups: (Array.isArray(rows) ? rows : []).map(row => ({
      name: row.name,
      bytes: Number(row.metadata?.size || 0),
      created_at: row.created_at || null,
      updated_at: row.updated_at || null
    }))
  };
}
