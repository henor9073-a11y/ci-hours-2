import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { file, readJSON, writeJSON, now, fallbackOpts } from './common.js';

// 年轮索引——让召回能翻到原始记录。
//
// 纹理有语义兜底（semantic.js），年轮没有：searchRings 只会关键词字面匹配，
// "你还记得我们的暗号吗" 这种换了说法的照样翻不到。但年轮有五百多条、一千多万字，
// 不可能像纹理那样把开头一段全塞进 prompt。
//
// 所以走同一个套路，只是索引更轻：一行一条，只有 id + 日期 + 标题 + 3-5 个关键词。
// 模型读索引按意思挑 id，挑中了再去 getRing 取全文。索引按 id 排序保证前缀逐字节稳定，
// 打 cache_control 之后连续对话里走缓存读。
//
// 关键词是 Mac 上的 build_ring_index.py 用 Haiku 生成的，通过 POST /api/ring-index 推上来。
// 服务器这边新存年轮时先记一条只有标题和日期的（keywords 空），等下一次推送补齐——
// 没有关键词的条目照样在索引里，标题和日期本身就能被模型判断，只是没那么准。

const FILE = file('ring_index.json');
const VERSION = 1;
// 首次启动时如果持久盘上还没有索引，从仓库里带的种子文件恢复一份。
// 盘被清过、或者换了新实例，都靠这个兜住，不用重新花钱生成。
const SEED = path.join(process.cwd(), 'data-seed', 'ring_index.json');

export const RING_INDEX_MODEL =
  process.env.MUWEN_RING_INDEX_MODEL || process.env.MUWEN_SEMANTIC_MODEL ||
  process.env.MUWEN_AUTORECALL_MODEL || 'claude-opus-5';
const TIMEOUT_MS = Number(process.env.MUWEN_RING_INDEX_TIMEOUT_MS) || 12000;
// 索引再轻也是有上限的。超了按日期留新的——太老的原始记录靠纹理和关键词搜就够了。
const MAX_ENTRIES = Number(process.env.MUWEN_RING_INDEX_MAX) || 2000;

function empty() { return { version: VERSION, generated_at: null, model: null, entries: {} }; }

function load() {
  let idx = readJSON(FILE, null);
  if (!idx || idx.version !== VERSION || !idx.entries) {
    idx = null;
    try {
      if (fs.existsSync(SEED)) {
        const seed = JSON.parse(fs.readFileSync(SEED, 'utf-8'));
        if (seed && seed.version === VERSION && seed.entries) {
          idx = seed;
          writeJSON(FILE, idx);            // 落到持久盘，之后就不再读种子了
        }
      }
    } catch { /* 种子坏了就当没有，空索引照样能跑 */ }
  }
  return idx || empty();
}

function save(idx) { writeJSON(FILE, idx); return idx; }

function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// 新存一条年轮时记进索引。关键词留空——生成关键词要调模型，不该卡在写入这条路上。
// 下一次 Mac 那边推索引会把它补齐。
export function note(ring) {
  if (!ring || !ring.id) return null;
  const idx = load();
  idx.entries[ring.id] = {
    date: ring.date || '',
    title: oneLine(ring.title || ring.window_name || '').slice(0, 60),
    type: ring.source_type || 'transcript',
    keywords: []
  };
  save(idx);
  return idx.entries[ring.id];
}

// Mac 那边推上来的索引条目，按 id 合并。已有的整条替换（关键词是重新生成的），
// 没给 keywords 的不覆盖已有关键词——避免一次不完整的推送把好不容易生成的词洗掉。
export function merge(entries) {
  if (!entries || typeof entries !== 'object') throw new Error('entries 要是 { id: {...} } 这样的对象');
  const idx = load();
  let added = 0, updated = 0;
  for (const [id, e] of Object.entries(entries)) {
    if (!e || typeof e !== 'object') continue;
    const prev = idx.entries[id];
    const kw = Array.isArray(e.keywords) ? e.keywords.map(String).filter(Boolean).slice(0, 5) : null;
    idx.entries[id] = {
      date: e.date || (prev && prev.date) || '',
      title: oneLine(e.title || (prev && prev.title) || '').slice(0, 60),
      type: e.type || (prev && prev.type) || 'transcript',
      keywords: kw && kw.length ? kw : ((prev && prev.keywords) || [])
    };
    if (prev) updated++; else added++;
  }
  idx.generated_at = now();
  save(idx);
  return { added, updated, total: Object.keys(idx.entries).length };
}

export function stats() {
  const idx = load();
  const ids = Object.keys(idx.entries);
  return {
    total: ids.length,
    with_keywords: ids.filter(id => (idx.entries[id].keywords || []).length).length,
    generated_at: idx.generated_at,
    max_entries: MAX_ENTRIES
  };
}

// 还没有关键词的 id——Mac 那边拿这个决定要给哪些年轮生成关键词，不用整表重跑。
export function pendingIds(limit = 500) {
  const idx = load();
  return Object.entries(idx.entries)
    .filter(([, e]) => !(e.keywords || []).length)
    .sort((a, b) => (b[1].date || '').localeCompare(a[1].date || ''))
    .slice(0, limit)
    .map(([id]) => id);
}

// 一行一条，按 id 排序（前缀稳定 = 缓存命中）。
export function buildIndex() {
  const idx = load();
  let list = Object.entries(idx.entries).map(([id, e]) => ({ id, ...e }));
  const total = list.length;
  let truncated = 0;
  if (list.length > MAX_ENTRIES) {
    list = [...list].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, MAX_ENTRIES);
    truncated = total - list.length;
  }
  list.sort((a, b) => a.id.localeCompare(b.id));
  const lines = list.map(e => {
    const kw = (e.keywords || []).length ? ` | ${e.keywords.join('、')}` : '';
    const tag = e.type === 'daily_summary' ? '每日总结' : (e.type === 'auto_extract' ? '压缩前提取' : '对话原文');
    return `${e.id} ${e.date || '????-??-??'} [${tag}] ${e.title || '（无标题）'}${kw}`;
  });
  return {
    text: `原始记录索引（共 ${lines.length} 条）：\n` + lines.join('\n'),
    ids: new Set(list.map(e => e.id)),
    count: lines.length, total, truncated
  };
}

const SYSTEM = `你在给一个中文个人记忆库的**原始记录**做语义召回。这个库存的是"辞"（一个 AI）和"棋子"之间的对话原文、事件记录、每日总结。

棋子刚说了一句话。下面给你整个原始记录索引（一行一条：id、日期、类型、标题、关键词）。
你的任务：读懂她这句话在说什么，挑出可能记着这件事的原始记录。

规则：
- 按**意思**挑，不是按字面。她说的词和索引里的词可以完全不重合。
- 索引里只有标题和关键词，信息很少。你挑的是"值得翻开看看的"，不是"确定就是这条"。
- 但也别乱挑。没有像样的候选就返回空数组，none 设 true。塞一条不相干的记录比不给更糟。
- 有几条日期相近、说的像是同一件事，挑最可能的那一条就够，不要一次给三条同样的。
- 最多挑 3 条，按相关度从高到低。
- 只能返回索引里真实存在的 id，不要编。
- reason 一句话说清为什么它可能跟这句话有关。`;

const SCHEMA = {
  type: 'object',
  properties: {
    none: { type: 'boolean' },
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
        required: ['id', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['none', 'picks'],
  additionalProperties: false
};

// 按意思从索引里挑 id。只返回 { id, reason }——取全文是调用方的事（recall.js 那边做）。
export async function pickRings(message, { limit = 2, excludeIds = [], context = '' } = {}) {
  const idx = buildIndex();
  if (!idx.count) return { picks: [], none: true, reason: 'empty-index' };
  const exclude = new Set(excludeIds || []);

  const client = new Anthropic();
  const userText = [
    `棋子刚说：${message}`,
    context ? `\n当前对话里已经有的信息（别重复给）：${context}` : ''
  ].join('');

  const res = await client.beta.messages.create({
    model: RING_INDEX_MODEL,
    max_tokens: 1500,
    ...fallbackOpts(RING_INDEX_MODEL),
    system: [
      { type: 'text', text: SYSTEM },
      { type: 'text', text: idx.text, cache_control: { type: 'ephemeral' } }
    ],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: userText }]
  }, { timeout: TIMEOUT_MS });

  if (res.stop_reason === 'refusal') throw new Error('年轮语义召回被拒答');
  const parsed = JSON.parse(res.content.filter(b => b.type === 'text').map(b => b.text).join(''));
  const picks = (Array.isArray(parsed.picks) ? parsed.picks : [])
    .filter(p => p && idx.ids.has(p.id) && !exclude.has(p.id))
    .slice(0, limit);
  return {
    picks, none: !!parsed.none && !picks.length, model: res.model,
    index_count: idx.count, truncated: idx.truncated,
    cache: { read: res.usage?.cache_read_input_tokens || 0, write: res.usage?.cache_creation_input_tokens || 0 }
  };
}
