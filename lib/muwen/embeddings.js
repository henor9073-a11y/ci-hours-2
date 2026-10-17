import crypto from 'node:crypto';
import { file, readJSON, writeJSON, now } from './common.js';
import { allGrains } from './grains.js';
import { recallableNotes } from './notebook.js';
import { profileRecallEntries } from './profiles.js';
import { recallProvider } from './structured-llm.js';

// OpenAI 只负责把记忆变成可比较的数字向量。正文仍在木纹自己的持久盘，索引文件也只
// 存在 /data；每条记忆只有新增或正文变动时才会重新请求一次，不会每轮把整库重发。
const INDEX_FILE = file('recall_embeddings.json');
const INDEX_VERSION = 1;
export const EMBEDDING_MODEL = process.env.MUWEN_EMBEDDING_MODEL || 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = Math.max(64, Math.min(1536, Number(process.env.MUWEN_EMBEDDING_DIMENSIONS) || 512));
const TIMEOUT_MS = Number(process.env.MUWEN_EMBEDDING_TIMEOUT_MS) || 30000;
const BATCH_SIZE = Math.max(1, Math.min(256, Number(process.env.MUWEN_EMBEDDING_BATCH_SIZE) || 96));
let warming = null;

function key() { return String(process.env.OPENAI_API_KEY || '').trim(); }
export function embeddingsReady() { return recallProvider() === 'openai' && !!key(); }

function oneLine(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24); }

function sources() {
  const out = [];
  for (const grain of allGrains().filter(item => item.status !== 'archived')) {
    const text = [
      `类型：${grain.category}`,
      grain.date ? `日期：${grain.date}` : '',
      grain.families?.length ? `关联：${grain.families.join('、')}` : '',
      `内容：${oneLine(grain.text).slice(0, 6000)}`
    ].filter(Boolean).join('\n');
    out.push({ id: grain.id, kind: 'grain', text, source: grain });
  }
  try {
    for (const note of recallableNotes()) {
      const text = [
        `类型：便签 ${note.section}`,
        note.at ? `日期：${String(note.at).slice(0, 10)}` : '',
        note.tags?.length ? `标签：${note.tags.join('、')}` : '',
        `内容：${oneLine(note.text).slice(0, 6000)}`
      ].filter(Boolean).join('\n');
      out.push({ id: note.id, kind: 'note', text, source: note });
    }
  } catch { /* notebook 未同步不影响纹理索引 */ }
  try {
    for (const profile of profileRecallEntries()) {
      const text = [
        `类型：档案 ${profile.owner_label} ${profile.field_label}`,
        profile.updated_at ? `更新：${String(profile.updated_at).slice(0, 10)}` : '',
        `内容：${oneLine(profile.text)}`
      ].filter(Boolean).join('\n');
      out.push({ id: profile.id, kind: 'profile', text, source: profile });
    }
  } catch { /* profiles 未迁移/读坏不影响其余索引 */ }
  return out;
}

function blankIndex() {
  return { version: INDEX_VERSION, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, updated_at: '', entries: {} };
}

function loadIndex() {
  const index = readJSON(INDEX_FILE, null);
  if (!index || index.version !== INDEX_VERSION || index.model !== EMBEDDING_MODEL
    || index.dimensions !== EMBEDDING_DIMENSIONS || !index.entries || typeof index.entries !== 'object') {
    return blankIndex();
  }
  return index;
}

async function createEmbeddings(input, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!key()) throw new Error('OpenAI embeddings 未配置 OPENAI_API_KEY');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key()}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input,
        encoding_format: 'float',
        dimensions: EMBEDDING_DIMENSIONS
      })
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`OpenAI embeddings 超时（${timeoutMs}ms）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(`OpenAI embeddings 失败：${String(detail).slice(0, 300)}`);
  }
  const data = Array.isArray(body.data) ? [...body.data].sort((a, b) => a.index - b.index) : [];
  if (data.length !== input.length || data.some(item => !Array.isArray(item.embedding))) {
    throw new Error(`OpenAI embeddings 返回数量不对（要 ${input.length}，收到 ${data.length}）`);
  }
  return { vectors: data.map(item => item.embedding), usage: body.usage || {} };
}

export function embeddingStats() {
  const index = loadIndex();
  const list = sources();
  const total = list.length;
  const indexed = list.filter(item => index.entries[item.id]?.hash === hash(item.text)).length;
  return { ready: embeddingsReady(), model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS,
    indexed, total, pending: Math.max(0, total - indexed), warming: !!warming, updated_at: index.updated_at || null };
}

export async function syncEmbeddings({ fetchImpl = globalThis.fetch, batchSize = BATCH_SIZE, limit = Infinity } = {}) {
  if (!embeddingsReady()) return { skipped: 'OpenAI embeddings 未启用', ...embeddingStats() };
  const list = sources();
  const currentIds = new Set(list.map(item => item.id));
  const index = loadIndex();
  let removed = 0;
  for (const id of Object.keys(index.entries)) {
    if (!currentIds.has(id)) { delete index.entries[id]; removed++; }
  }
  const pending = list.filter(item => index.entries[item.id]?.hash !== hash(item.text)).slice(0, limit);
  let embedded = 0;
  let inputTokens = 0;
  for (let start = 0; start < pending.length; start += batchSize) {
    const batch = pending.slice(start, start + batchSize);
    const result = await createEmbeddings(batch.map(item => item.text), { fetchImpl });
    batch.forEach((item, offset) => {
      index.entries[item.id] = { kind: item.kind, hash: hash(item.text), vector: result.vectors[offset] };
    });
    embedded += batch.length;
    inputTokens += Number(result.usage?.prompt_tokens || result.usage?.total_tokens || 0);
    index.updated_at = now();
    // 每批都落盘：部署中途重启也只补没做完的，不从头花钱。
    writeJSON(INDEX_FILE, index);
  }
  if (!pending.length && removed) {
    index.updated_at = now();
    writeJSON(INDEX_FILE, index);
  }
  const indexed = list.filter(item => index.entries[item.id]?.hash === hash(item.text)).length;
  return { indexed, total: list.length, embedded, removed,
    pending: Math.max(0, list.length - indexed), input_tokens: inputTokens,
    model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, updated_at: index.updated_at || null };
}

export function warmEmbeddings(options = {}) {
  if (!embeddingsReady()) return Promise.resolve({ skipped: 'OpenAI embeddings 未启用', ...embeddingStats() });
  if (warming) return warming;
  warming = syncEmbeddings(options).finally(() => { warming = null; });
  return warming;
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return -1;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
}

export async function vectorCandidates(query, { limit = 14, excludeIds = [], fetchImpl = globalThis.fetch } = {}) {
  if (!embeddingsReady()) return { candidates: [], skipped: 'OpenAI embeddings 未启用', ...embeddingStats() };
  const index = loadIndex();
  const list = sources();
  const byId = new Map(list.map(item => [item.id, item]));
  const indexed = list.filter(item => index.entries[item.id]?.hash === hash(item.text)).length;
  if (indexed < list.length || Object.keys(index.entries).some(id => !byId.has(id))) {
    warmEmbeddings({ fetchImpl }).catch(() => {});
  }
  if (!indexed) return { candidates: [], warming: true, indexed: 0, total: list.length, pending: list.length };

  const result = await createEmbeddings([String(query || '')], { fetchImpl });
  const queryVector = result.vectors[0];
  const exclude = new Set(excludeIds || []);
  const scored = [];
  for (const [id, entry] of Object.entries(index.entries)) {
    if (exclude.has(id)) continue;
    const item = byId.get(id);
    if (!item || entry.hash !== hash(item.text)) continue;
    scored.push({ ...item, similarity: cosine(queryVector, entry.vector) });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return { candidates: scored.slice(0, limit), indexed, total: list.length,
    pending: Math.max(0, list.length - indexed), model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS };
}

export const _test = { cosine, createEmbeddings, sources, loadIndex, hash };
