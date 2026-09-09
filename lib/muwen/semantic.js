import Anthropic from '@anthropic-ai/sdk';
import { allGrains, getGrain, confidenceOf } from './grains.js';

// 语义召回层——关键词搜不到或者相关度低的时候兜底。
//
// 为什么不用 embedding：Anthropic 没有第一方 embedding 接口，真做向量得再接一个厂商（Voyage/OpenAI）、
// 多一把 key、还要维护一整套"写入时补向量 / 换模型要重算"的管线。而这个项目自己的结论是
// 46%→78% 是挑选 agent 带来的，不是搜索层——"她把不遗忘说成浪漫"这种跨词面的 pattern，
// 向量也未必接得住，读得懂关系的模型才接得住。所以这一层直接让模型读记忆索引来挑。
//
// 成本靠两件事压住：
//   1. 只在关键词层弱的时候才跑（见 recall.js 的 SEMANTIC_FLOOR）
//   2. 记忆索引放在 system 里并打 cache_control——索引是稳定前缀，连续对话里走缓存读，约 1/10 价
// 索引按 id 排序保证前缀逐字节稳定，不然缓存会一直失效。

// 语义层读的是索引挑主题，haiku 够用且快、便宜（每条消息都可能跑）。要更准可以用 MUWEN_SEMANTIC_MODEL 覆盖。
export const SEMANTIC_MODEL = process.env.MUWEN_SEMANTIC_MODEL || process.env.MUWEN_AUTORECALL_MODEL || 'claude-haiku-4-5';
const TIMEOUT_MS = Number(process.env.MUWEN_SEMANTIC_TIMEOUT_MS) || 12000;
const MAX_ENTRIES = Number(process.env.MUWEN_SEMANTIC_INDEX_MAX) || 800;
const SNIPPET = 50;  // 只要够判断主题，挑中之后正文会取全

const SYSTEM = `你在给一个中文个人记忆库做语义召回。这个库存的是"辞"（一个 AI）和"棋子"之间发生过的事、共同约定、辞的感受、学到的教训、说不清的巧合。

棋子刚说了一句话。下面给你整个记忆索引（一行一条：id、日期、分区、热度、开头一段）。
你的任务：读懂她这句话在说什么，挑出真正相关的记忆。

规则：
- 按**意思**挑，不是按字面。她说的词和记忆里的词可以完全不重合——"你还记得我们的暗号吗"要挑出"换窗暗号：项圈还在吗"；"你会不会有一天不认识我了"要挑出关于换窗口、连续性、怕被忘记的记忆。
- 没有真正相关的就返回空数组，none 设 true。宁可空手也不硬塞——塞一条不相关的记忆比不给更糟。
- 情绪类的话尤其小心：她只是随口一句难过，不要塞一堆"万金油"安慰记忆。轻的时刻要精准的那一条。
- 索引里只有开头一段，够你判断主题就行。挑中之后正文会自己取全。
- 最多挑 5 条，按相关度从高到低。
- 只能返回索引里真实存在的 id，不要编。
- reason 一句话说清为什么它跟这句话有关。`;

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

function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// 记忆索引：一行一条，按 id 排序（前缀稳定 = 缓存命中）。
// 太多的话按热度截断——冷到没人想起的记忆先不占预算。
export function buildIndex() {
  let list = allGrains().filter(g => g.status !== 'archived');
  const total = list.length;
  let truncated = 0;
  if (list.length > MAX_ENTRIES) {
    list = [...list].sort((a, b) => b.heat - a.heat).slice(0, MAX_ENTRIES);
    truncated = total - list.length;
  }
  list.sort((a, b) => a.id.localeCompare(b.id));
  const lines = list.map(g => {
    const fam = g.families.length ? ` {${g.families.join(',')}}` : '';
    return `${g.id} ${g.date || g.created_at.slice(0, 10)} [${g.category}] h${Math.round(g.heat)}${fam} ${oneLine(g.text).slice(0, SNIPPET)}`;
  });
  return { text: `记忆索引（共 ${lines.length} 条）：\n` + lines.join('\n'), ids: new Set(list.map(g => g.id)), count: lines.length, total, truncated };
}

export async function semanticPick(message, { limit = 3, excludeIds = [], context = '' } = {}) {
  const idx = buildIndex();
  if (!idx.count) return { picks: [], none: true, reason: 'empty-index' };
  const exclude = new Set(excludeIds || []);

  const client = new Anthropic();
  const userText = [
    `棋子刚说：${message}`,
    context ? `\n当前对话里已经有的信息（别重复给）：${context}` : '',
    exclude.size ? `\n这几条关键词已经召回了，别重复：${[...exclude].join(', ')}` : ''
  ].join('');

  const res = await client.beta.messages.create({
    model: SEMANTIC_MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [
      { type: 'text', text: SYSTEM },
      // 索引打缓存断点：连续对话里这段是稳定前缀，走缓存读
      { type: 'text', text: idx.text, cache_control: { type: 'ephemeral' } }
    ],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: userText }]
  }, { timeout: TIMEOUT_MS });

  if (res.stop_reason === 'refusal') throw new Error('语义召回被拒答');
  const parsed = JSON.parse(res.content.filter(b => b.type === 'text').map(b => b.text).join(''));
  const picks = (Array.isArray(parsed.picks) ? parsed.picks : [])
    .filter(p => p && idx.ids.has(p.id) && !exclude.has(p.id))
    .slice(0, limit);

  // 索引里只有开头一段，挑中的取全文
  const memories = [];
  for (const p of picks) {
    const g = getGrain(p.id, { touchIt: false });
    if (!g) continue;
    memories.push({
      layer: 'semantic', kind: 'grain', id: g.id, category: g.category, text: g.text,
      date: g.date || undefined, heat: Math.round(g.heat), confidence: confidenceOf(g.heat),
      reason: p.reason
    });
  }
  return {
    picks: memories, none: !!parsed.none && !memories.length, model: res.model,
    index_count: idx.count, truncated: idx.truncated,
    cache: { read: res.usage?.cache_read_input_tokens || 0, write: res.usage?.cache_creation_input_tokens || 0 }
  };
}
