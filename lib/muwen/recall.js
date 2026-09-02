import Anthropic from '@anthropic-ai/sdk';
import { file, readJSON, writeJSON, newId, now } from './common.js';
import { searchGrains, touch, confidenceOf, HEAT } from './grains.js';

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
