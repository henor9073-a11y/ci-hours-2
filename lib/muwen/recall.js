import Anthropic from '@anthropic-ai/sdk';
import { file, readJSON, writeJSON, newId, now } from './common.js';
import { searchGrains, touch, confidenceOf, HEAT } from './grains.js';
import { searchRings } from './rings.js';

// 召回系统（设计文档第四节）。核心原则：先觉察，后想起。不是每轮自动搜，什么时候想起由辞定。
//   第一层 Notice：辞自己写一句 notice（"这让我想到了什么"）
//   第二层 搜索：notice → search_grains 出 ≤20 条候选池。搜索找的是"像"的，不是"相关"的
//   第三层 Recall Agent：一个足够好的模型读 notice + 候选池 + 当前 context，挑真正相关的返回，可能返回空
// 每次调用都记日志（recall_logs.json）——可验证，才是记忆系统最值钱的特性。

const LOG_FILE = file('recall_logs.json');
const CANDIDATE_LIMIT = 20;
const MAX_RETURN = 5;

// 挑选层是关键也是短板，必须用足够好的模型。Flash/DeepSeek 级别不会空手而归、不会跨词面识别 pattern。
export const RECALL_MODEL = process.env.MUWEN_RECALL_MODEL || 'claude-opus-5';

const SYSTEM_PROMPT = `你是记忆挑选员。从候选池中挑选与 notice 真正相关的记忆返回。

规则：
- 如果没有真正相关的记忆，返回空数组。宁可空手也不硬塞。
- context_summary 里已经提到的信息不要重复给。
- 同一主题有多条记忆时，选最重要的（heat 最高的），不选最近的。
- 情绪类 context 不要塞万金油安慰记忆。轻的时刻需要精准的记忆，不是泛泛的。
- 要跨词面识别 pattern：notice 和记忆的用词可以完全不重合，只要说的是同一种说话方式、同一种关系模式，就算相关。
- 最多返回 ${MAX_RETURN} 条。
- 只能返回候选池里有的 id，不要编造。
- reason 用一句话说明为什么选这条。`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    selected: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reason: { type: 'string' }
        },
        required: ['id', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['selected'],
  additionalProperties: false
};

function appendLog(entry) {
  const list = readJSON(LOG_FILE, []);
  list.push(entry);
  writeJSON(LOG_FILE, list);
  return entry;
}
export function getRecallLogs(limit = 30) {
  return readJSON(LOG_FILE, []).slice(-limit).reverse();
}

function candidateView(g) {
  return {
    id: g.id, category: g.category, text: g.text, date: g.date || undefined,
    families: g.families.length ? g.families : undefined, heat: Math.round(g.heat)
  };
}

async function runAgent({ notice, context_summary, candidates }) {
  const client = new Anthropic();
  const userText = [
    `notice：${notice}`,
    context_summary ? `\ncontext_summary（当前对话里已经有的信息）：${context_summary}` : '',
    `\n候选池（${candidates.length} 条）：`,
    JSON.stringify(candidates.map(candidateView), null, 1)
  ].join('\n');
  const response = await client.beta.messages.create({
    model: RECALL_MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    messages: [{ role: 'user', content: userText }]
  });
  if (response.stop_reason === 'refusal') {
    throw new Error(`recall agent 拒答：${(response.stop_details && response.stop_details.category) || 'unknown'}`);
  }
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const parsed = JSON.parse(text);
  return { selected: Array.isArray(parsed.selected) ? parsed.selected : [], model: response.model };
}

export async function recall(notice, context_summary = '') {
  if (!notice || !String(notice).trim()) throw new Error('notice 不能为空——先写一句"这让我想到了什么"');
  notice = String(notice).trim();
  // 候选池不升温（不然每次 recall 都把 20 条一起顶上去），只有被 agent 挑中返回的才 +5
  const candidates = searchGrains({ query: notice, limit: CANDIDATE_LIMIT, touchHits: false });
  const log = {
    id: newId('rc'), notice, context_summary: context_summary || '',
    candidates: candidates.length, returned: 0, returned_ids: [], agent: null, model: null, error: null,
    created_at: now()
  };
  if (!candidates.length) {
    appendLog(log);
    return { notice, memories: [], candidates: 0, agent: 'none', note: '搜索层没有候选，空手而归。' };
  }
  let selected = [];
  let agent = 'llm';
  let note = '';
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (!hasKey) {
    agent = 'fallback';
    note = '服务器没配 ANTHROPIC_API_KEY，recall agent 没跑——下面是搜索层按相似度排的前几条，不是挑过的，准确率会差很多（实测 46% vs 78%）。';
    selected = candidates.slice(0, MAX_RETURN).map(g => ({ id: g.id, reason: `搜索相似度 ${g.score}（未经 agent 挑选）` }));
  } else {
    try {
      const r = await runAgent({ notice, context_summary, candidates });
      log.model = r.model;
      const byId = Object.fromEntries(candidates.map(c => [c.id, c]));
      selected = r.selected.filter(s => byId[s.id]).slice(0, MAX_RETURN);
      note = selected.length ? '' : 'recall agent 看过候选池，没有真正相关的，空手而归。';
    } catch (e) {
      agent = 'error';
      log.error = String(e.message || e);
      note = `recall agent 调用失败（${log.error}），退回搜索层的前几条，不是挑过的。`;
      selected = candidates.slice(0, MAX_RETURN).map(g => ({ id: g.id, reason: `搜索相似度 ${g.score}（agent 失败）` }));
    }
  }
  log.agent = agent;
  log.returned = selected.length;
  log.returned_ids = selected.map(s => s.id);
  appendLog(log);
  // 被返回的记忆 heat += 5
  const touched = touch(log.returned_ids, 'recall');
  const byId = Object.fromEntries(touched.map(g => [g.id, g]));
  const memories = selected.map(s => {
    const g = byId[s.id] || candidates.find(c => c.id === s.id);
    return {
      id: g.id, category: g.category, text: g.text, date: g.date || undefined,
      families: g.families.length ? g.families : undefined,
      heat: Math.round(g.heat), confidence: confidenceOf(g.heat), reason: s.reason
    };
  });
  return {
    notice, memories, candidates: candidates.length, agent, model: log.model || undefined, log_id: log.id,
    note: note || undefined,
    confidence_hint: `cite(heat>${HEAT.CITE}) 可以直接当事实说；cautious(${HEAT.CAUTIOUS}-${HEAT.CITE}) 用犹豫的语气；reference(<${HEAT.CAUTIOUS}) 只在内部参考不说出来`
  };
}

// =====================================================
// 自动召回（auto-recall）——参考 LMC-5 的 UserPromptSubmit 每轮召回。
// 棋子每发一条消息，GPD 的钩子后台调 POST /api/recall，用消息内容做 query，
// 匹配到的记忆自动注入辞的 context，辞不用手动搜。
// 两层级联（木纹没有向量，对应 LMC-5 的关键词→原始事件两层）：
//   第一层 authority：纹理 grains 关键词命中（curated，权威）
//   第二层 last-resort：纹理太弱时翻年轮 rings（原始记录，只当线索不当权威）
// 默认不跑 recall agent（每条消息都调 LLM 太贵/太慢）；MUWEN_AUTORECALL_AGENT=1 打开精选。
// 琐碎消息（"嗯""好的""ok"、单字、纯标点）直接跳过，不浪费算力也不塞万金油。
// =====================================================

const TRIVIAL_PUNCT = /^[\s，。！？、~～.!?…·、：:;；'"''""()（）\-—]*$/;
const STOPWORDS = new Set(['嗯', '嗯嗯', '嗯呢', '好', '好的', '好呀', '好吧', '行', '行吧', '哦', '噢', '喔', '是', '是的', '对', '对的', '谢谢', '谢谢你', '收到', '在', '在的', '在呢', 'ok', 'okay', 'k', 'yes', 'no', '哈', '哈哈', '哈哈哈', '嘿嘿', '嗯嗯嗯', '晚安', '早', '早安']);

export function isTrivial(text) {
  const t = String(text || '').trim();
  if (t.length <= 1) return true;
  if (TRIVIAL_PUNCT.test(t)) return true;
  if (STOPWORDS.has(t.toLowerCase())) return true;
  return false;
}

export async function autoRecall(query, { maxReturn = 3, minScore = 6, useAgent = null, context = '', touchHits = false, excludeIds = [] } = {}) {
  const q = String(query || '').trim();
  if (isTrivial(q)) return { query: q, trivial: true, memories: [], layers_used: [] };
  const exclude = new Set(excludeIds || []);
  const layersUsed = [];

  // 第一层：纹理关键词搜索（curated / authority）。不主动升温，避免每条消息把同一批记忆顶上天。
  // 门槛调严：score 要过 minScore（≈两个双字词命中或一次整句命中），再只留跟最高分同档的，
  // 免得一个偶然的双字巧合就把一堆弱相关记忆注进去（设计文档说的"万金油"）。
  let grainHits = searchGrains({ query: q, limit: Math.max(maxReturn * 6, 24), touchHits: false })
    .filter(g => g.score >= minScore && !exclude.has(g.id));
  if (grainHits.length) {
    // 长度归一化：超长记忆容易靠零散双字命中刷分挤掉短的精确匹配（"8月7日记忆空白补完"那种），
    // 除权一下让它不靠体量取胜。含 query 里 ≥3 字连续子串的给一记强加成（更接近"真的在说这件事"）。
    for (const g of grainHits) {
      let sub = 0;
      for (let n = Math.min(6, q.length); n >= 3 && !sub; n--) {
        for (let i = 0; i + n <= q.length; i++) { if (g.text.includes(q.slice(i, i + n))) { sub = n * 4; break; } }
      }
      g._adj = (g.score + sub) / (1 + g.text.length / 800);
    }
    grainHits.sort((a, b) => b._adj - a._adj);
    const top = grainHits[0]._adj;
    grainHits = grainHits.filter(g => g._adj >= Math.max(minScore / 2, top * 0.5));
    layersUsed.push('grains');
  }

  const best = grainHits.length ? grainHits[0].score : 0;
  const agent = useAgent === null ? (process.env.MUWEN_AUTORECALL_AGENT === '1') : useAgent;

  let picked = grainHits.slice(0, maxReturn);
  let via = grainHits.length ? 'search' : 'none';

  // 可选：候选够多时用 recall agent 精选（贵，默认关）。空手而归也照单全收。
  if (agent && grainHits.length > 1) {
    try {
      const r = await recall(q, context);
      if (r.agent === 'llm') {
        const byId = Object.fromEntries(grainHits.map(g => [g.id, g]));
        const refined = r.memories.filter(m => byId[m.id]).map(m => ({ ...byId[m.id], reason: m.reason }));
        if (refined.length) { picked = refined.slice(0, maxReturn); via = 'agent'; }
        else picked = []; // agent 明确说没有相关的，就别塞
      }
    } catch { /* agent 失败就退回 search 结果 */ }
  }

  // 第二层：纹理没给出够强的命中，翻年轮找线索（last-resort，只当参考不当权威）
  let rawHits = [];
  if (!picked.length) {
    rawHits = searchRings({ query: q, limit: 3 }).filter(r => r.score >= minScore);
    if (rawHits.length) layersUsed.push('rings');
  }

  if (touchHits && picked.length) touch(picked.map(g => g.id), 'recall');

  const memories = [
    ...picked.map(g => ({
      layer: 'authority', kind: 'grain', id: g.id, category: g.category, text: g.text,
      date: g.date || undefined, heat: Math.round(g.heat), confidence: g.confidence,
      score: g.score, reason: g.reason || undefined
    })),
    ...rawHits.slice(0, maxReturn - picked.length).map(r => ({
      layer: 'last_resort', kind: 'ring', id: r.id, window_name: r.window_name,
      date: r.date, excerpt: r.excerpt, score: r.score
    }))
  ];

  // 记一条精简日志（跟手动 recall 共用 recall_logs.json，标记 auto）
  try {
    const logs = readJSON(LOG_FILE, []);
    logs.push({ id: newId('ar'), auto: true, notice: q, via, returned: memories.length, returned_ids: memories.map(m => m.id), layers: layersUsed, created_at: now() });
    writeJSON(LOG_FILE, logs);
  } catch { /* 日志失败不影响返回 */ }

  return { query: q, via, memories, layers_used: layersUsed };
}

// 把 autoRecall 结果拼成给钩子注入的文本（带 [muwen:recall] 前缀，配合阅后即焚 hook 清理旧的）。
export function formatInjection(result) {
  if (!result || !result.memories || !result.memories.length) return '';
  const lines = ['[muwen:recall] 相关记忆（棋子这条消息自动召回的，未必都相关，自己判断，别硬套）：'];
  for (const m of result.memories) {
    if (m.layer === 'last_resort') {
      lines.push(`· [年轮·线索] ${m.date || ''} ${m.window_name || ''}：${(m.excerpt || '').replace(/\s+/g, ' ').slice(0, 120)}`);
    } else {
      const conf = m.confidence === 'cite' ? '' : (m.confidence === 'cautious' ? '（记得不太牢，留点余地）' : '（很淡，仅供参考）');
      lines.push(`· [${m.category}·heat${m.heat}] ${m.date ? m.date + ' ' : ''}${m.text.replace(/\s+/g, ' ').slice(0, 200)}${conf}`);
    }
  }
  return lines.join('\n');
}
