import Anthropic from '@anthropic-ai/sdk';
import { file, readJSON, writeJSON, newId, now, fallbackOpts, effortOpts } from './common.js';
import { searchGrains, touch, confidenceOf, HEAT } from './grains.js';
import { searchRings, getRing } from './rings.js';
import { semanticPick } from './semantic.js';
import { clipToSentence, bigrams, nearDuplicate, bestPassage } from './search.js';
import { pickRings } from './ring-index.js';
import { isReadonly } from './readonly.js';
import { mentionedPeople, formatPerson } from './social.js';

// 召回系统（设计文档第四节）。核心原则：先觉察，后想起。不是每轮自动搜，什么时候想起由辞定。
//   第一层 Notice：辞自己写一句 notice（"这让我想到了什么"）
//   第二层 搜索：notice → search_grains 出 ≤20 条候选池。搜索找的是"像"的，不是"相关"的
//   第三层 Recall Agent：一个足够好的模型读 notice + 候选池 + 当前 context，挑真正相关的返回，可能返回空
// 每次调用都记日志（recall_logs.json）——可验证，才是记忆系统最值钱的特性。

const LOG_FILE = file('recall_logs.json');
const CANDIDATE_LIMIT = 20;

// ---- 辞 2026-09-27 定的三个量 ----
// 自然联想（闲聊里顺带想起）最多 3 条；她明确在查历史时放到 6 条。
export const ASSOC_MAX = Number(process.env.MUWEN_ASSOC_MAX) || 3;
export const HISTORY_MAX = Number(process.env.MUWEN_HISTORY_MAX) || 6;
// 刚浮现过的旧事别一遍遍再浮现（"此刻的用途对不对"里的一条）。问历史时不压制。
export const SUPPRESS_MINUTES = Number(process.env.MUWEN_SUPPRESS_MINUTES) || 30;
// 注入总量上限：超了宁可少给几条，也不要把她的上下文占掉一大块。
export const INJECT_BUDGET = Number(process.env.MUWEN_INJECT_BUDGET) || 1500;

// 判"她是不是在查历史"。本地正则先判一道（不花钱、不加延迟），
// 开了 agent 的话模型给的 intent 再补一道，两边谁说是就算是——
// 漏判只是少给几条，误判会让闲聊里灌进六条旧事，所以宁可漏。
const HISTORY_RE = /之前|以前|上次|上回|上一次|那次|当时|原话|说过|提过|讲过|答应过|约定过|怎么说的|是不是说|记不记得|还记得|翻一下|翻翻|查一下|找一下|复述|重复一遍|原来那个|原来的方案|上个方案/;
export function isHistoryAsk(text) { return HISTORY_RE.test(String(text || '')); }

// 最近 N 分钟已经浮现过的记忆 id。
// ⚠️ 读的是召回日志＝"准备浮现"，不是"辞真的说出口了"——我们没有回执机制。
// 所以这是近似：这一轮召回出来但辞没用上的，也会被算成"提过"。
export function recentlySurfaced(minutes = SUPPRESS_MINUTES) {
  const cutoff = Date.now() - minutes * 60000;
  const ids = new Set();
  for (const l of readJSON(LOG_FILE, []).slice(-200)) {
    const t = Date.parse(l.created_at || '');
    if (!Number.isFinite(t) || t < cutoff) continue;
    for (const id of l.returned_ids || []) ids.add(id);
  }
  return ids;
}
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

四道准入（挑之前逐条过，过不了就别选）：
1. 主体对不对——记忆里的"我"是辞写的就指辞。别人的经历、同名的人，不能算到棋子头上。
2. 事件真不真——真发生过、只是计划、明确没发生、梦里或写着玩的，要分清楚。判断的是她这次问的那个动作。
3. 时间对不对——问"上次"就认最近那一次，哪怕那次什么也没发生。记录日期和事件日期是两回事，没写的属性不要补造。
4. 此刻的用途对不对——要有具体的私人联系，光是同一个词、情绪差不多，不够。旧的工作记录不能拿来当现在的状态。
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
  if (isReadonly()) return entry;
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
    ...fallbackOpts(RECALL_MODEL),
    system: SYSTEM_PROMPT,
    output_config: { ...effortOpts(RECALL_MODEL, 'medium'), format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
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
//   第二层 last-resort：纹理太弱时翻年轮 rings（原始记录，只当线索不当权威）——
//     先关键词搜，字面没搜到再让模型读年轮索引按意思挑（ring-index.js，跟纹理的语义层同一个套路）
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


// ---- 轻量 agent 模式：意图提取（query expansion，参考 LMC-5 Stage 0）----
// 关键词层的天花板是"换了说法就召不到"："你还记得我们的暗号吗" 里根本没有"项圈"两个字。
// 打开 MUWEN_AUTORECALL_AGENT=1 之后，每条非琐碎消息先跑一次模型，把消息改写成 2-4 个检索角度
// （关键实体 / 同义说法 / 情绪主题 / 指代还原），每个角度各搜一遍，按 id 合并取最高分。
// 只多一次模型调用——不是再跑一遍挑选 agent，那个是 recall() 干的事。
export const AUTORECALL_MODEL = process.env.MUWEN_AUTORECALL_MODEL || 'claude-opus-5';
// 关键词层的长度归一化分数低于这条线，就认为"没搜到或者搜得不准"，兜底走语义层。
// 实测：真命中 25–49，换了说法的语义查询卡在 15–18，22 能把两者分开。
const SEMANTIC_FLOOR = Number(process.env.MUWEN_SEMANTIC_FLOOR) || 22;
// 年轮关键词层的门槛，用覆盖率（最相关那一段拿到的分 ÷ 完美命中的满分），
// 不用绝对分数——绝对分数会被查询里的废话带跑。实测八个查询：
//   真命中   0.44 / 0.46 / 0.57 / 0.60   （"牙结石清理要全麻我不放心"→初始问候 等）
//   跨不过去 0.23 / 0.24 / 0.31 / 0.36   （"我家狗要不要打麻药洗牙那件事后来怎么样了" 等）
// 中间有明显空档，取 0.40。跨不过去的那些正是该交给年轮索引层的——
// 洗牙↔洁牙、麻药↔全麻，关键词永远搭不上这座桥。
const RING_COVERAGE_FLOOR = Number(process.env.MUWEN_RING_COVERAGE_FLOOR) || 0.4;
// 关键词纹理的相关性下限：低于这条线的一条都不返回，宁可只给一两条，
// 也不要凑满三条而第三条完全不相干。离线量过 256 条纹理 × 16 个查询：
//   关键词对得上的（审讯游戏/项圈/黑色秋田/坦白药剂/木纹改名…）  顶格 21.7–38.3
//   跟记忆库无关的（订机票/时间复杂度/川菜馆/洗衣机…）           顶格 0–17.3
// 空档在 17.3 和 21.7 之间，取 20。注意这跟 SEMANTIC_FLOOR(22) 是两回事：
// 那条线管"要不要再跑一次语义层"，这条线管"这条到底配不配被返回"。
const RELEVANCE_FLOOR = Number(process.env.MUWEN_RELEVANCE_FLOOR) || 20;
// 同一个分区最多占几条。三条结果全是 experience 的话，等于只从一个角度想起这件事——
// 强制最后一格留给别的分区（learning/agreement/年轮…）里分最高的那条。
// 凑不出别的分区就少给一条，不降格凑数。
function categoryCap(maxReturn) { return maxReturn >= 3 ? maxReturn - 1 : maxReturn; }
const INTENT_TIMEOUT_MS = Number(process.env.MUWEN_AUTORECALL_TIMEOUT_MS) || 5000;

const INTENT_SYSTEM = `你在给一个中文个人记忆库做检索词扩写。用户（棋子）发来一句话，你要判断"要不要翻记忆"，
以及"翻的话该用什么词去搜"。这个记忆库里存的是她和辞（一个 AI）之间发生过的事、约定、感受、教训。

输出 2-4 个检索角度（queries），每个角度是一小段能拿去做关键词匹配的中文，覆盖：
- 关键实体和专有名词（人名、物件名、暗号、地点、事件名）
- 同义说法和这个圈子里的黑话（比如"暗号"很可能对应"项圈还在吗""换窗暗号"）
- 情绪主题（比如"她不高兴"对应"吵架""生气""哭了"）
- 指代还原（"那次""上回"要还原成可能的具体事件）

规则：
- queries 是拿去做**关键词字面匹配**的，所以要给具体的词，不要给"关于两人关系的记忆"这种抽象描述。
- 猜的时候可以放开一点，多给一个角度不要紧，但每个角度都要是有可能真的出现在记忆原文里的说法。
- 如果这句话根本不需要翻记忆（纯寒暄、当下的操作指令、跟过去无关的新话题），skip 设 true，queries 给空数组。
- intent 分两档：她在问"我们之前怎么说的""上次那个方案"这类查历史的话，给 "answer"；
  只是聊天、分享近况、顺带可能想起旧事的，给 "association"。拿不准就给 association。
- 只输出 JSON。`;

const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    skip: { type: 'boolean' },
    intent: { type: 'string', enum: ['association', 'answer'] },
    queries: { type: 'array', items: { type: 'string' } },
    why: { type: 'string' }
  },
  required: ['skip', 'intent', 'queries', 'why'],
  additionalProperties: false
};

export async function extractIntent(message) {
  const client = new Anthropic();
  const res = await client.beta.messages.create({
    model: AUTORECALL_MODEL,
    max_tokens: 1000,
    ...fallbackOpts(AUTORECALL_MODEL),
    system: INTENT_SYSTEM,
    // 低 effort：这是每条消息都要跑的小活，要快要便宜
    output_config: { ...effortOpts(AUTORECALL_MODEL, 'low'), format: { type: 'json_schema', schema: INTENT_SCHEMA } },
    messages: [{ role: 'user', content: String(message) }]
  }, { timeout: INTENT_TIMEOUT_MS });
  if (res.stop_reason === 'refusal') throw new Error('intent agent 拒答');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const parsed = JSON.parse(text);
  return {
    skip: !!parsed.skip,
    intent: parsed.intent === 'answer' ? 'answer' : 'association',
    queries: Array.isArray(parsed.queries) ? parsed.queries.map(String).filter(Boolean).slice(0, 4) : [],
    why: String(parsed.why || ''),
    model: res.model
  };
}

// 给一批命中算长度归一化后的分数：超长记忆容易靠零散双字命中刷分挤掉短的精确匹配，除权一下；
// 含 query 里 ≥3 字连续子串的给强加成（更接近"真的在说这件事"）。
function rankGrains(q, hits) {
  for (const g of hits) {
    let sub = 0;
    for (let n = Math.min(6, q.length); n >= 3 && !sub; n--) {
      for (let i = 0; i + n <= q.length; i++) { if (g.text.includes(q.slice(i, i + n))) { sub = n * 4; break; } }
    }
    g._adj = (g.score + sub) / (1 + g.text.length / 800);
  }
  return hits;
}

export async function autoRecall(query, { maxReturn: maxReturnOpt = null, minScore = 6, suppressRecent = true, useAgent = null, context = '', touchHits = false, excludeIds = [], queries = null, useSemantic = null, _semanticPick = null, _pickRings = null } = {}) {
  const q = String(query || '').trim();
  // 提到了谁：名字是精确的，不用走打分，直接把人卡 + 最近的八卦带上。不占 maxReturn 的名额。
  let people = [];
  try { people = mentionedPeople(q); } catch { /* 人卡读坏了不影响正常召回 */ }
  if (isTrivial(q)) return { query: q, trivial: true, memories: [], layers_used: people.length ? ['social'] : [], angles: [], people };
  const exclude = new Set(excludeIds || []);
  const layersUsed = [];
  // 先用本地正则判一道；开了 agent 的话下面模型还会再判一道
  let askedHistory = isHistoryAsk(q);
  let maxReturn = ASSOC_MAX;
  const agent = useAgent === null ? (process.env.MUWEN_AUTORECALL_AGENT === '1') : useAgent;

  // 检索角度：原句永远算一个（保住精确匹配），agent 模式下再加模型扩写出来的 2-4 个。
  let angles = [q];
  let via = 'search';
  let intentWhy = '';
  if (Array.isArray(queries) && queries.length) {          // 调用方直接给角度（测试/钩子预扩写用）
    angles = [q, ...queries.map(String)]; via = 'given';
  } else if (agent) {
    try {
      const intent = await extractIntent(q);
      intentWhy = intent.why;
      if (intent.intent === 'answer') askedHistory = true;
      if (intent.skip && !intent.queries.length) {
        return { query: q, skipped_by_agent: true, why: intentWhy, memories: [], layers_used: [], angles: [] };
      }
      angles = [q, ...intent.queries];
      via = 'intent-agent';
    } catch (e) {
      via = 'search-fallback';                              // 模型挂了/没配 key，退回原句关键词
      intentWhy = String(e.message || e);
    }
  }
  angles = [...new Set(angles.map(a => a.trim()).filter(Boolean))];

  // 自然联想 3 条、查历史 6 条（3 条联想 + 3 条额外）。调用方显式传了就听调用方的。
  maxReturn = maxReturnOpt || (askedHistory ? HISTORY_MAX : ASSOC_MAX);
  // 30 分钟内浮现过的这轮不再出现——除非她正在主动问历史
  const recent = (askedHistory || !suppressRecent) ? new Set() : recentlySurfaced();

  // 第一层：纹理关键词搜索（curated / authority）。每个角度各搜一遍，按 id 合并取最高分，
  // 被多个角度同时命中的加一点分（多个说法都指向它 = 更可能真的相关）。不主动升温。
  const merged = new Map();
  for (const a of angles) {
    const hits = rankGrains(a, searchGrains({ query: a, limit: Math.max(maxReturn * 6, 24), touchHits: false })
      .filter(g => g.score >= minScore && !exclude.has(g.id)));
    for (const g of hits) {
      const prev = merged.get(g.id);
      if (prev) { prev._adj = Math.max(prev._adj, g._adj) + 1; prev._angles.push(a); }
      else merged.set(g.id, { ...g, _angles: [a] });
    }
  }
  let grainHits = [...merged.values()].sort((a, b) => b._adj - a._adj);
  if (grainHits.length) {
    const top = grainHits[0]._adj;
    grainHits = grainHits.filter(g => g._adj >= Math.max(minScore / 2, top * 0.5));
    layersUsed.push('grains');
  }
  // 候选池留宽——最终的条数由下面的相关性下限和分区多样性一起决定。
  // 这里就砍到 maxReturn 的话，多样性只能在头几条里挑，而头几条很可能同一个分区，
  // 想换分区的那条早就被丢掉了。
  let picked = grainHits.slice(0, maxReturn * 4);

  // 第二层：语义兜底。关键词一条没搜到、或者最高分没过 SEMANTIC_FLOOR（说明只是字面沾边），
  // 就让模型读记忆索引按意思挑一遍——"你还记得我们的暗号吗"这种换了说法的靠这层接住。
  // 只在 agent 模式下开（MUWEN_AUTORECALL_SEMANTIC=0 可单独关掉）。
  let semantic = null;
  const topAdj = picked.length ? picked[0]._adj : 0;
  const semanticOn = useSemantic === null ? (agent && process.env.MUWEN_AUTORECALL_SEMANTIC !== '0') : !!useSemantic;
  if (semanticOn && topAdj < SEMANTIC_FLOOR) {
    try {
      const pick = _semanticPick || semanticPick;   // _semanticPick 是测试接缝，正常不传
      const r = await pick(q, { limit: maxReturn, excludeIds: picked.map(g => g.id), context });
      if (r.picks.length) { semantic = r; layersUsed.push('semantic'); via = via === 'intent-agent' ? 'intent+semantic' : 'semantic'; }
    } catch (e) { intentWhy = (intentWhy ? intentWhy + '；' : '') + `语义层失败：${e.message || e}`; }
  }
  // 语义层是在"关键词不准"的前提下才跑的，所以它挑的排前面，关键词的填剩下的位置
  // 语义层挑的排在候选池最前面，自然优先占位，不用在这里提前砍关键词那批。
  const semanticMemories = semantic ? semantic.picks : [];

  // 第三层：前两层没给出像样的东西，翻年轮找线索（last_resort，只当参考不当权威）。
  // 门槛跟语义层同一条线（topAdj < SEMANTIC_FLOOR），不是"必须一条都没搜到"——
  // 库里两百多条纹理、中文又是按字匹配，关键词层几乎总能搜出点沾边的东西来。
  // 用"空手"当门槛的话，年轮这层实际上永远不会触发：一句"我家狗要不要洗牙"
  // 能把"夫妻关系"和"记忆写法"顶上来，然后把真正记着这件事的原始记录挡在外面。
  let rawHits = [];
  let ringSemantic = null;
  if (!semanticMemories.length && topAdj < SEMANTIC_FLOOR) {
    for (const a of angles) {
      rawHits.push(...searchRings({ query: a, limit: 5 }).filter(r => r.score >= minScore));
    }
    rawHits = [...new Map(rawHits.map(r => [r.id, r])).values()]
      // 覆盖率过不了线的一律扔掉——留着只会拿一段毫不相干的原文占位置。
      // 这一层的规矩跟别处一样：宁可空手，也不硬塞。
      .filter(r => (r.coverage || 0) >= RING_COVERAGE_FLOOR)
      .sort((a, b) => b.score - a.score);
    if (rawHits.length) layersUsed.push('rings');

    // 关键词也没在年轮里搜到——让模型读年轮索引按意思挑一遍。（注意这里 topAdj 已经
    // 低于 SEMANTIC_FLOOR，语义层也空手了，所以这是最后一次机会，不是额外加塞）
    // 索引只有标题+日期+关键词，挑出来的是"值得翻开看看的"，所以照样算 last_resort，不当权威。
    if (!rawHits.length && semanticOn) {
      try {
        const pick = _pickRings || pickRings;
        const r = await pick(q, { limit: Math.min(2, maxReturn), context });
        if (r.picks.length) {
          ringSemantic = r;
          for (const p of r.picks) {
            const ring = getRing(p.id);
            if (!ring) continue;
            rawHits.push({
              id: ring.id, window_name: ring.window_name, date: ring.date,
              excerpt: (ring.content || '').slice(0, 300), reason: p.reason, via: 'semantic'
            });
          }
          if (rawHits.length) layersUsed.push('rings-semantic');
        }
      } catch (e) {
        intentWhy = (intentWhy ? intentWhy + '；' : '') + `年轮语义层失败：${e.message || e}`;
      }
    }
  }

  // 相关性下限：关键词纹理里分不够的直接不要。语义层挑的不过这条线——
  // 那是模型读完索引挑的，本来就没有关键词分数，而且它被交代过"宁可空手不硬塞"。
  const dropped = picked.filter(g => g._adj < RELEVANCE_FLOOR).length;
  picked = picked.filter(g => g._adj >= RELEVANCE_FLOOR);

  // 按优先级排好的候选池：语义层挑的 > 关键词纹理 > 年轮线索。
  const pool = [
    ...semanticMemories.map(m => ({ cat: m.category || 'semantic', m })),
    ...picked.map(g => ({ cat: g.category, m: {
      layer: 'authority', kind: 'grain', id: g.id, category: g.category, text: g.text,
      date: g.date || undefined, heat: Math.round(g.heat), confidence: g.confidence,
      score: g.score, adj: Math.round(g._adj * 10) / 10, matched_angles: g._angles
    } })),
    ...rawHits.map(r => ({ cat: 'ring', m: {
      layer: 'last_resort', kind: 'ring', id: r.id, window_name: r.window_name,
      date: r.date, excerpt: r.excerpt, score: r.score,
      ...(r.reason ? { reason: r.reason, via: r.via } : {})
    } }))
  ];

  // 分区多样性 + 去重。候选按优先级顺序贪心取，所以"第三格换个分区"自然就是
  // "其他分区里排最前的那条"；近似重复的只留排在前面那条（排前面的分更高）。
  const cap = categoryCap(maxReturn);
  const used = {};
  const memories = [];
  const seenIds = new Set();
  const seenGrams = [];
  let duplicates = 0;
  let suppressed = 0;
  for (const { cat, m } of pool) {
    if (memories.length >= maxReturn) break;
    if (seenIds.has(m.id)) continue;                     // 同一条被两层各召回一次
    if (recent.has(m.id)) { suppressed++; continue; }    // 半小时内刚浮现过，别又端一遍
    if ((used[cat] || 0) >= cap) continue;
    // 同一件事写过浓缩版和完整版的不少，两条一起返回等于浪费一个名额
    const grams = bigrams(m.text || m.excerpt || '');
    if (seenGrams.some(prev => nearDuplicate(prev, grams))) { duplicates++; continue; }
    seenIds.add(m.id);
    seenGrams.push(grams);
    used[cat] = (used[cat] || 0) + 1;
    memories.push(m);
  }

  const returnedGrainIds = memories.filter(m => m.kind === 'grain' && m.layer === 'authority').map(m => m.id);
  if (touchHits && returnedGrainIds.length) touch(returnedGrainIds, 'recall');

  if (!isReadonly()) try {
    const logs = readJSON(LOG_FILE, []);
    logs.push({ id: newId('ar'), auto: true, notice: q, via, angles, why: intentWhy || undefined,
      top_adj: topAdj || undefined,
      semantic: semantic ? { picked: semanticMemories.length, index: semantic.index_count, model: semantic.model, cache: semantic.cache } : undefined,
      below_floor: dropped || undefined,
      duplicates: duplicates || undefined,
      suppressed: suppressed || undefined,
      intent: askedHistory ? 'answer' : 'association',
      ring_semantic: ringSemantic ? { picked: ringSemantic.picks.length, index: ringSemantic.index_count, model: ringSemantic.model, cache: ringSemantic.cache } : undefined,
      people: people.length ? people.map(x => x.matched) : undefined,
      returned: memories.length, returned_ids: memories.map(m => m.id), layers: layersUsed, created_at: now() });
    writeJSON(LOG_FILE, logs);
  } catch { /* 日志失败不影响返回 */ }

  if (people.length) layersUsed.unshift('social');
  return { query: q, via, angles, why: intentWhy || undefined, memories, layers_used: layersUsed, people,
    intent: askedHistory ? 'answer' : 'association', max_return: maxReturn,
    categories: Object.keys(used), below_floor: dropped || undefined,
    duplicates: duplicates || undefined, suppressed: suppressed || undefined,
    ...(semantic ? { semantic: { index_count: semantic.index_count, truncated: semantic.truncated, model: semantic.model, cache: semantic.cache } } : {}),
    ...(ringSemantic ? { ring_semantic: { index_count: ringSemantic.index_count, truncated: ringSemantic.truncated, model: ringSemantic.model, cache: ringSemantic.cache } } : {}) };
}

// 片段级精度：不把整条记忆倒出来，先找正文里跟这句话最相关的一段，再截到句子结尾。
// 以前是从开头硬截 200 字——长记忆的开头往往是背景交代，真正相关的那句在中间，截不到。
function fragment(query, text, limit) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= limit) return t;
  const q = String(query || '').trim();
  // 没有查询词就退回老办法（从头截），有的话按窗口打分定位。
  // 窗口就取 limit：开得比 limit 大的话，短一点的正文整段落进一个窗口，等于没定位。
  let start = q ? bestPassage(q, t, { window: limit, step: Math.max(60, Math.round(limit / 2)) }).start : 0;
  if (start > 0) {
    // 别从半句话中间起头：往前找最近的句子结尾（找不到就算了，前面加省略号）
    const before = t.slice(Math.max(0, start - 60), start);
    const m = [...before.matchAll(/[。！？…!?]["'』」）)]*/g)].pop();
    if (m) start = Math.max(0, start - 60) + m.index + m[0].length;
  }
  const clipped = clipToSentence(t.slice(start), limit);
  return (start > 0 ? '…' : '') + clipped;
}

// 把 autoRecall 结果拼成给钩子注入的文本（带 [muwen:recall] 前缀，配合阅后即焚 hook 清理旧的）。
// 总量卡在 INJECT_BUDGET（1500 字）：装不下的宁可不给，也不要把她的上下文占掉一大块。
export function formatInjection(result) {
  if (!result) return '';
  const people = result.people || [];
  if (!(result.memories && result.memories.length) && !people.length) return '';
  const q = result.query || '';
  const head = '[muwen:recall] 相关记忆（棋子这条消息自动召回的，未必都相关，自己判断，别硬套；这些是旧事，不是此刻的事实）：';
  const lines = [head];
  let used = head.length;
  let dropped = 0;
  // 一条一条加，加不下就停——后面的按相关度本来就排在后面
  const push = line => {
    if (used + line.length + 1 > INJECT_BUDGET) { dropped++; return false; }
    lines.push(line);
    used += line.length + 1;
    return true;
  };

  for (const x of people) {
    if (x.person) push(`· [人] ${formatPerson(x.person)}`);
    else push(`· [人] ${x.matched}（还没有卡片，只有八卦）`);
    for (const g of x.gossip) push(`  · [八卦 ${g.date}] ${fragment(q, g.text, 160)}`);
  }
  for (const m of result.memories || []) {
    if (m.layer === 'semantic') {
      const conf = m.confidence === 'cite' ? '' : '（记得不太牢，留点余地）';
      push(`· [语义·${m.category}·heat${m.heat}] ${m.date ? m.date + ' ' : ''}${fragment(q, m.text, 200)}${conf}${m.reason ? `　← ${m.reason}` : ''}`);
    } else if (m.layer === 'last_resort') {
      const why = m.reason ? `　← ${m.reason}` : '';
      // 年轮片段比纹理给得长一点——它是原文线索，太短了看不出在说什么
      push(`· [年轮·线索] ${m.date || ''} ${m.window_name || ''}：${fragment(q, m.excerpt || '', 200)}${why}`);
    } else {
      const conf = m.confidence === 'cite' ? '' : (m.confidence === 'cautious' ? '（记得不太牢，留点余地）' : '（很淡，仅供参考）');
      push(`· [${m.category}·heat${m.heat}] ${m.date ? m.date + ' ' : ''}${fragment(q, m.text, 200)}${conf}`);
    }
  }
  if (dropped) {
    const note = `（还有 ${dropped} 条没放进来，超字数了）`;
    if (used + note.length + 1 <= INJECT_BUDGET + note.length) lines.push(note);
  }
  return lines.join('\n');
}
