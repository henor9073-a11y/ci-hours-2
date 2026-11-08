import crypto from 'node:crypto';
import { file, now, readJSON, writeJSON } from './muwen/common.js';

// 外部窗口的向量索引与辞的木纹严格分文件、分 window_id。这里只索引外部窗口
// 的最终可见正文、可信阶段记录和该窗口长期记忆；不索引 thinking，也不跨窗口召回。
const INDEX_FILE = file('external-space-embeddings.json');
const INDEX_VERSION = 1;
const MODEL = process.env.EXTERNAL_EMBEDDING_MODEL || process.env.MUWEN_EMBEDDING_MODEL || 'text-embedding-3-small';
const DIMENSIONS = Math.max(64, Math.min(1536, Number(process.env.EXTERNAL_EMBEDDING_DIMENSIONS || process.env.MUWEN_EMBEDDING_DIMENSIONS) || 512));
const TIMEOUT_MS = Number(process.env.EXTERNAL_EMBEDDING_TIMEOUT_MS) || 30000;
const BATCH_SIZE = Math.max(1, Math.min(128, Number(process.env.EXTERNAL_EMBEDDING_BATCH_SIZE) || 64));
const MIN_SIMILARITY = Math.max(-1, Math.min(1, Number(process.env.EXTERNAL_SEMANTIC_MIN_SIMILARITY) || 0.28));

function key() { return String(process.env.OPENAI_API_KEY || '').trim(); }
export function externalEmbeddingsReady() { return !!key(); }
function digest(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24); }
function oneLine(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

function blankIndex() {
  return { version: INDEX_VERSION, model: MODEL, dimensions: DIMENSIONS, updated_at: '', entries: {} };
}

function loadIndex() {
  const value = readJSON(INDEX_FILE, null);
  if (!value || value.version !== INDEX_VERSION || value.model !== MODEL || value.dimensions !== DIMENSIONS
    || !value.entries || typeof value.entries !== 'object') return blankIndex();
  return value;
}

function visibleMessageText(message) {
  const body = oneLine(message.transcript || message.content || '');
  if (body) return body;
  const images = (message.attachments || []).filter(item => item.kind === 'image').length;
  const audio = (message.attachments || []).filter(item => item.kind === 'audio').length;
  return [images ? `[${images}张图片]` : '', audio ? `[${audio}段语音，暂无转写]` : ''].filter(Boolean).join(' ');
}

function rawChunks(window) {
  const messages = (window.messages || []).filter(item => ['user', 'assistant'].includes(item.role));
  const chunks = [];
  for (let start = 0; start < messages.length; start += 8) {
    const group = messages.slice(start, start + 8);
    const lines = group.map(message => {
      const label = message.role === 'user' ? '棋子' : '我';
      return `[${message.at || ''}][${message.id}][${label}] ${visibleMessageText(message)}`;
    }).filter(line => !line.endsWith('] '));
    if (!lines.length) continue;
    chunks.push({
      id: `raw:${group[0].id}:${group.at(-1).id}`,
      kind: 'raw', text: lines.join('\n').slice(0, 12000),
      at: group.at(-1).at || '', source_message_ids: group.map(item => item.id)
    });
  }
  return chunks;
}

export function externalEmbeddingSources(window) {
  const sources = [];
  for (const memory of window.memories || []) {
    if (memory.status !== 'active' || memory.recallable === false) continue;
    sources.push({
      id: `memory:${memory.id}`, kind: 'memory',
      text: `[长期记忆·${memory.kind || 'note'}] ${memory.text}`,
      at: memory.updated_at || memory.created_at || '',
      source_message_ids: memory.source_message_ids || [], source_id: memory.id
    });
  }
  for (const episode of window.episodes || []) {
    if (episode.recallable === false || episode.perspective !== 'first_person') continue;
    sources.push({
      id: `episode:${episode.id}`, kind: 'episode',
      text: `[阶段记录] ${episode.summary}\n主题：${(episode.topics || []).join('、')}\n未解决：${(episode.unresolved || []).join('；')}`,
      at: episode.created_at || '', source_message_ids: episode.source_message_ids || [], source_id: episode.id
    });
  }
  sources.push(...rawChunks(window));
  return sources.map(source => ({ ...source, window_id: window.id }));
}

async function createEmbeddings(input, fetchImpl = globalThis.fetch) {
  if (!key()) throw new Error('外部窗口语义召回未配置 OpenAI embedding key');
  const response = await fetchImpl('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key()}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({ model: MODEL, input, encoding_format: 'float', dimensions: DIMENSIONS })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`外部窗口 embeddings 失败：${String(body?.error?.message || response.status).slice(0, 240)}`);
  const rows = Array.isArray(body.data) ? [...body.data].sort((a, b) => a.index - b.index) : [];
  if (rows.length !== input.length || rows.some(item => !Array.isArray(item.embedding))) throw new Error('外部窗口 embeddings 返回数量不对');
  return rows.map(item => item.embedding);
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return -1;
  let dot = 0, aa = 0, bb = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index]; aa += a[index] * a[index]; bb += b[index] * b[index];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
}

export async function syncExternalWindowEmbeddings(window, { fetchImpl = globalThis.fetch } = {}) {
  const sources = externalEmbeddingSources(window);
  if (!externalEmbeddingsReady()) return { ready: false, indexed: 0, total: sources.length, pending: sources.length };
  const index = loadIndex();
  const current = new Set(sources.map(source => `${window.id}:${source.id}`));
  for (const entryID of Object.keys(index.entries)) {
    if (index.entries[entryID]?.window_id === window.id && !current.has(entryID)) delete index.entries[entryID];
  }
  const pending = sources.filter(source => {
    const entry = index.entries[`${window.id}:${source.id}`];
    return !entry || entry.hash !== digest(source.text);
  });
  let embedded = 0;
  for (let start = 0; start < pending.length; start += BATCH_SIZE) {
    const batch = pending.slice(start, start + BATCH_SIZE);
    const vectors = await createEmbeddings(batch.map(item => item.text), fetchImpl);
    batch.forEach((source, offset) => {
      index.entries[`${window.id}:${source.id}`] = {
        window_id: window.id, source_id: source.id, kind: source.kind,
        hash: digest(source.text), vector: vectors[offset]
      };
    });
    embedded += batch.length;
    index.updated_at = now();
    writeJSON(INDEX_FILE, index);
  }
  return { ready: true, indexed: sources.length, total: sources.length, pending: 0, embedded, model: MODEL };
}

export async function recallExternalWindow(window, query, {
  limit = 14, charBudget = 26000, excludeMessageIDs = [], kinds = [], fetchImpl = globalThis.fetch
} = {}) {
  const sources = externalEmbeddingSources(window);
  if (!externalEmbeddingsReady() || !String(query || '').trim()) {
    return { ready: false, sources: [], total: sources.length };
  }
  await syncExternalWindowEmbeddings(window, { fetchImpl });
  const index = loadIndex();
  const [queryVector] = await createEmbeddings([String(query)], fetchImpl);
  const excluded = new Set(excludeMessageIDs || []);
  const allowedKinds = new Set(kinds || []);
  const scored = [];
  for (const source of sources) {
    if (allowedKinds.size && !allowedKinds.has(source.kind)) continue;
    // 最近工作区已原样提供，旧原话召回不再重复注入同一段。
    if (source.kind === 'raw' && source.source_message_ids.some(id => excluded.has(id))) continue;
    const entry = index.entries[`${window.id}:${source.id}`];
    if (!entry || entry.hash !== digest(source.text)) continue;
    const similarity = cosine(queryVector, entry.vector);
    if (similarity >= MIN_SIMILARITY) scored.push({ ...source, similarity });
  }
  scored.sort((a, b) => b.similarity - a.similarity || String(b.at).localeCompare(String(a.at)));
  const selected = [];
  let used = 0;
  for (const item of scored) {
    if (selected.length >= Math.max(1, Math.min(Number(limit) || 14, 30))) break;
    if (used + item.text.length > Math.max(2000, Math.min(Number(charBudget) || 26000, 60000))) continue;
    selected.push(item); used += item.text.length;
  }
  return { ready: true, sources: selected, total: sources.length, model: MODEL, dimensions: DIMENSIONS };
}

export function externalEmbeddingStats(window) {
  const sources = externalEmbeddingSources(window);
  const index = loadIndex();
  const indexed = sources.filter(source => index.entries[`${window.id}:${source.id}`]?.hash === digest(source.text)).length;
  return { ready: externalEmbeddingsReady(), model: MODEL, dimensions: DIMENSIONS, indexed, total: sources.length, pending: sources.length - indexed };
}

export const _test = { cosine, createEmbeddings, rawChunks, loadIndex, digest };
