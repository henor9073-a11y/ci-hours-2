import { newId, now } from './common.js';
import { searchGrains, touch, confidenceOf, HEAT, listFamilies } from './grains.js';
import { searchRings, getRing } from './rings.js';
import { semanticPick } from './semantic.js';
import { clipToSentence, bigrams, nearDuplicate, bestPassage, score } from './search.js';
import { pickRings } from './ring-index.js';
import { appendRecallLog, recentRecallLogs, getRecallLogs, warmRecallLogs, recallLogStats } from './recall-log.js';
import { searchNotes } from './notebook.js';
import { mentionedPeople, formatPerson } from './social.js';
import { profileRecallEntries } from './profiles.js';
import { generateStructured, providerReady, recallModel, recallProvider } from './structured-llm.js';

// 召回系统（设计文档第四节）。核心原则：先觉察，后想起。不是每轮自动搜，什么时候想起由辞定。
//   第一层 Notice：辞自己写一句 notice（"这让我想到了什么"）
//   第二层 搜索：notice → search_grains 出 ≤20 条候选池。搜索找的是"像"的，不是"相关"的
//   第三层 Recall Agent：一个足够好的模型读 notice + 候选池 + 当前 context，挑真正相关的返回，可能返回空
// 每次调用都记日志（recall_logs/YYYY-MM-DD.jsonl，存储层在 recall-log.js）——可验证，才是记忆系统最值钱的特性。

export { getRecallLogs, warmRecallLogs, recallLogStats };
const CANDIDATE_LIMIT = 20;
export const RECALL_PROVIDER = recallProvider();
export const RECALL_PROVIDER_READY = providerReady();

// ---- 辞 2026-09-27 定的三个量 ----
// 自然联想（闲聊里顺带想起）最多 3 条；她明确在查历史时放到 6 条。
// 30 分钟内不重复，避免三条上限变成反复灌同一批旧事。
export const ASSOC_MAX = Number(process.env.MUWEN_ASSOC_MAX) || 3;
export const HISTORY_MAX = Number(process.env.MUWEN_HISTORY_MAX) || 6;
// 刚浮现过的旧事别一遍遍再浮现（"此刻的用途对不对"里的一条）。问历史时不压制。
export const SUPPRESS_MINUTES = Number(process.env.MUWEN_SUPPRESS_MINUTES) || 30;
// 注入总量上限：超了宁可少给几条，也不要把她的上下文占掉一大块。
export const INJECT_BUDGET = Number(process.env.MUWEN_INJECT_BUDGET) || 900;

// ---- 短话不召回（2026-11-14 棋子定：「辞说每句话都在召回，貌似没必要，有一些比较短的话不用召回吧」）----
// 两周日志（10-31～11-14，3696 次自动召回）按字数分桶：≤12 字占 22%，其中 57% 召回出了东西，
// 而这些"召回出来的"里 86% 只有语义层在撑（关键词顶分 <22，字面上一个词都没对上）——就是她说的"不准确"。
// ≤12 字里问历史口吻的只有 9 条、含明显锚点（日期 / 英文词 / 固定名词）的 121 条，这两类保留。
// 规则：≤12 字 且 不是问历史 且 没锚点 且 没提到具名的人 → 整个不召回：不读文件、不调模型、只记一条 skipped 日志。
export const SHORT_SKIP_MAX = Number(process.env.MUWEN_SHORT_SKIP_MAX) || 12;
// 13–20 字那一桶召回出来的里 67% 也只靠语义层。这一档关键词层照跑，语义层只在有锚点 / 问历史 / 提到人时才开。
export const SEMANTIC_MIN_LEN = Number(process.env.MUWEN_SEMANTIC_MIN_LEN) || 20;
// 锚点：有这些就算短也可能真在说某件事。家族标签（纹理的 families）也算锚点，在 hasAnchor 里动态查。
const ANCHOR_RE = /\d{1,2}\s*[月号日点]|\d{4}[-/.]\d{1,2}|[A-Za-z]{3,}|那天|那回|那会儿|那时候|小时候|去年|上个月|上周|昨天|前天|照片|图片|相册|截图|木屋|木纹|管家|小栗子|日记|便签|生日|纪念日/;
let familyCache = { stamp: 0, list: [] };
function familyAnchors() {
  // listFamilies 读的是带 mtime 缓存的 grains.json，这里再按分钟缓存一层，省得每句都排序 700 多个标签
  const minute = Math.floor(Date.now() / 60000);
  if (familyCache.stamp !== minute) {
    try { familyCache = { stamp: minute, list: listFamilies().map(f => f.family).filter(f => f.length >= 2) }; }
    catch { familyCache = { stamp: minute, list: [] }; }
  }
  return familyCache.list;
}
export function hasAnchor(text) {
  const t = String(text || '');
  if (ANCHOR_RE.test(t)) return true;
  return familyAnchors().some(f => t.includes(f));
}
// 返回空串＝不跳过；否则是跳过原因（short / call / system），给日志用。
export function skipReason(text, { people = [], origin = '' } = {}) {
  const q = String(text || '');
  const o = String(origin || '').toLowerCase();
  if (o === 'muwu_call' || /\borigin=["']?muwu_call\b/.test(q)) return 'call';      // 电话里每句话都不召回
  if (o === 'muwu_system' || /\borigin=["']?muwu_system\b/.test(q)) return 'system'; // 系统事件不是她在说话
  const t = q.replace(/\s+/g, '');
  if (t.length > SHORT_SKIP_MAX) return '';
  if (isHistoryAsk(t) || EXPLICIT_MEDIA_RE.test(t) || hasAnchor(t) || people.length) return '';
  return 'short';
}

// ---- 看前几句再召回（2026-11-14 棋子问：「召回的时候看一下上下文再召回会准一点吧？」）----
// 钩子传来的 context 是最近 8 句「棋子: …」「辞: …」。以前只在最后一步精选时给模型看一眼；
// 现在三处都用：① 同一个话题刚召回过就别再召（"每句话都在召回"的另一半原因）；
// ② 查询词加上前几句里的锚点，语义层的向量也用"当前句×2 + 前几句"合成；③ 和前几句沾得上的候选往前排。
// 问历史口吻（"上次怎么说的"）和明显换题的句子，context 不参与——别把一个新问题拖回旧话题。
const CONTEXT_LINES = Number(process.env.MUWEN_CONTEXT_LINES) || 3;
// 中文两句话哪怕在聊同一件事，双字重合也不高（"今天又去摆摊了"→"摆摊的时候脚酸得不行"只共 2 个双字），
// 所以判"还在聊同一件事"用：去掉万金油双字之后，至少共 2 个双字、且占当前句两成以上。
const SAME_TOPIC_MIN_SHARED = Number(process.env.MUWEN_SAME_TOPIC_SHARED) || 2;
const SAME_TOPIC_MIN_OVERLAP = Number(process.env.MUWEN_SAME_TOPIC_OVERLAP) || 0.2;
const SAME_TOPIC_RECALL_OVERLAP = Number(process.env.MUWEN_SAME_TOPIC_RECALL_OVERLAP) || 0.4; // 和 30 分钟内某次召回过的那句的重合度
// 哪句话里都有的双字，不算"同一个话题"的证据
const GENERIC_BIGRAMS = new Set('今天 明天 昨天 现在 刚才 后来 然后 就是 但是 还是 觉得 什么 怎么 一个 这个 那个 不是 可以 没有 知道 时候 的时 一下 一点 真的 有点 不要 可能 应该 已经 还有 这样 那样 这么 那么 我们 你们 他们 自己 东西 事情 感觉 一样 其实 反正 因为 所以 好像 是不 不是 的话 怎么 要不 要是 如果 而且 不过 只是 我的 你的 她的 他的 了一 一直 一起 不会 不想 想要 需要 开始 继续 等一 一会 会儿 的那 那种 这种 很多 一点 不太 比较 特别 非常 真是 还是'.split(/\s+/));
function topicGrams(text) { const out = new Set(); for (const t of bigrams(text)) if (!GENERIC_BIGRAMS.has(t)) out.add(t); return out; }
function sameTopic(qg, ctxg) {
  if (!qg.size || !ctxg.size) return false;
  let shared = 0;
  for (const t of qg) if (ctxg.has(t)) shared++;
  return shared >= SAME_TOPIC_MIN_SHARED && shared / qg.size >= SAME_TOPIC_MIN_OVERLAP;
}
const CONTEXT_RANK_WEIGHT = Number(process.env.MUWEN_CONTEXT_RANK_WEIGHT) || 4;        // 排序加权上限（关键词分一般 20–40）

function containment(small, large) {
  if (!small || !small.size || !large || !large.size) return 0;
  let hit = 0;
  for (const t of small) if (large.has(t)) hit++;
  return hit / small.size;
}
// 最近 n 句，去掉"棋子:"/"辞:"前缀；也接受没有前缀的纯文本
export function contextLines(context, n = CONTEXT_LINES) {
  return String(context || '').split(/\r?\n/)
    .map(l => l.replace(/^\s*(?:棋子|辞|nor|cy|user|assistant)\s*[:：]\s*/i, '').trim())
    .filter(Boolean).slice(-n);
}
// 前几句里的锚点：日期 / 英文词 / 固定名词 / 家族标签 / 具名的人。拿来跟当前句组一条查询。
export function contextAnchors(context, n = CONTEXT_LINES) {
  const text = contextLines(context, n).join(' ');
  if (!text) return [];
  const found = new Set();
  for (const m of text.matchAll(/\d{1,2}\s*[月号日点]|\d{4}[-/.]\d{1,2}|[A-Za-z]{3,}|木屋|木纹|管家|小栗子|日记|便签|生日|纪念日/g)) found.add(m[0]);
  for (const f of familyAnchors()) if (text.includes(f)) found.add(f);
  try { for (const p of mentionedPeople(text)) found.add(p.matched); } catch { /* 人卡读坏了不影响 */ }
  return [...found].slice(0, 6);
}
// 同话题刚召回过：当前句还在延续前几句的话题，而且 30 分钟内已经为这个话题召回出东西了 → 这次不召。
// 只看进程内存里的最近 200 条日志（recall-log.js），不读文件。
export function sameTopicRecently(query, context, { askedHistory = false, minutes = SUPPRESS_MINUTES, now: nowMs = Date.now() } = {}) {
  if (askedHistory) return false;
  const lines = contextLines(context);
  if (!lines.length) return false;
  const q = String(query || '');
  const qg = topicGrams(q);
  if (qg.size < 3) return false;                       // 太短判不了（短话另有规则）
  const ctxText = lines.join(' ');
  if (!sameTopic(qg, topicGrams(ctxText))) return false;   // 换题了
  const whole = topicGrams(q + ' ' + ctxText);
  const cutoff = nowMs - minutes * 60000;
  for (const l of recentRecallLogs()) {
    if (!l || l.auto !== true || !l.returned) continue;
    const t = Date.parse(l.created_at || '');
    if (!Number.isFinite(t) || t < cutoff) continue;
    const ng = topicGrams(l.notice || '');
    if (ng.size < 2) continue;
    // 那次召回的那句，要么大半落在"当前句 + 前几句"里，要么和当前句本身沾得上
    if (containment(ng, whole) >= SAME_TOPIC_RECALL_OVERLAP || sameTopic(qg, ng)) return true;
  }
  return false;
}

// 判"她是不是在查历史"。本地正则先判一道（不花钱、不加延迟），
// 开了 agent 的话模型给的 intent 再补一道，两边谁说是就算是——
// 漏判只是少给几条，误判会让闲聊里灌进六条旧事，所以宁可漏。
const HISTORY_RE = /之前|以前|上次|上回|上一次|那次|当时|原话|说过|提过|讲过|答应过|约定过|怎么说的|是不是说|记不记得|还记得|翻一下|翻翻|查一下|找一下|复述|重复一遍|原来那个|原来的方案|上个方案/;
export function isHistoryAsk(text) { return HISTORY_RE.test(String(text || '')); }
const EXPLICIT_MEDIA_RE = /照片|图片|相册|截图|影像|合照|自拍|找.{0,5}(?:照片|图片|图)|看.{0,4}(?:照片|图片|图)/;
const SHORT_CONTINUATION_RE = /^(?:嗯+|哦+|噢+|对|是啊?|应该|可能|也许|大概|好像|确实|本身|其实|就是|不是|我觉得)(?:[\s…，。！？~～]|$)/i;
export function isContextualShortContinuation(text, context = '') {
  const value = String(text || '').trim();
  return !!String(context || '').trim()
    && value.length <= 32
    && !isHistoryAsk(value)
    && !EXPLICIT_MEDIA_RE.test(value)
    && SHORT_CONTINUATION_RE.test(value);
}

// 最近 N 分钟已经浮现过的记忆 id。
// ⚠️ 读的是召回日志＝"准备浮现"，不是"辞真的说出口了"——我们没有回执机制。
// 所以这是近似：这一轮召回出来但辞没用上的，也会被算成"提过"。
// 只看进程内存里的最近 200 条（recall-log.js），不读文件——以前这里每次把 62MB 的日志整个读一遍。
export function recentlySurfaced(minutes = SUPPRESS_MINUTES) {
  const cutoff = Date.now() - minutes * 60000;
  const ids = new Set();
  for (const l of recentRecallLogs()) {
    const t = Date.parse(l.created_at || '');
    if (!Number.isFinite(t) || t < cutoff) continue;
    for (const id of l.returned_ids || []) ids.add(id);
  }
  return ids;
}
const MAX_RETURN = 5;

// 挑选层是关键也是短板：模型必须能稳定按 schema 返回、允许空手，并识别跨词面的私人联系。
export const RECALL_MODEL = recallModel('claude-opus-5', process.env.MUWEN_RECALL_MODEL);

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

// 只读模式（木纹网页）不记日志，这个判断在 appendRecallLog 里面。
function appendLog(entry) { return appendRecallLog(entry); }

function candidateView(g) {
  return {
    id: g.id, layer: g.kind === 'profile' ? 'profile' : 'grain', category: g.category,
    owner: g.owner, field: g.field, text: g.text, date: g.date || undefined,
    families: g.families?.length ? g.families : undefined,
    heat: Number.isFinite(g.heat) ? Math.round(g.heat) : undefined
  };
}

async function runAgent({ notice, context_summary, candidates }) {
  const userText = [
    `notice：${notice}`,
    context_summary ? `\ncontext_summary（当前对话里已经有的信息）：${context_summary}` : '',
    `\n候选池（${candidates.length} 条）：`,
    JSON.stringify(candidates.map(candidateView), null, 1)
  ].join('\n');
  const response = await generateStructured({
    model: RECALL_MODEL, anthropicDefault: 'claude-opus-5', maxTokens: 1600,
    system: SYSTEM_PROMPT, user: userText, schema: OUTPUT_SCHEMA, effort: 'medium'
  });
  return { selected: Array.isArray(response.data.selected) ? response.data.selected : [], model: response.model, provider: response.provider };
}

export async function recall(notice, context_summary = '') {
  if (!notice || !String(notice).trim()) throw new Error('notice 不能为空——先写一句"这让我想到了什么"');
  notice = String(notice).trim();
  // 候选池不升温（不然每次 recall 都把 20 条一起顶上去），只有被 agent 挑中返回的才 +5
  const candidates = [
    ...searchProfileMemories(notice, { limit: Math.ceil(CANDIDATE_LIMIT / 2), minScore: 6 }),
    ...searchGrains({ query: notice, limit: CANDIDATE_LIMIT, touchHits: false })
  ].sort((a, b) => (b._adj ?? b.score ?? 0) - (a._adj ?? a.score ?? 0)).slice(0, CANDIDATE_LIMIT);
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
  const hasKey = providerReady();
  if (!hasKey) {
    agent = 'fallback';
    note = '服务器没有可用的 recall provider，未把未经筛选的搜索结果注入。';
    selected = [];
  } else {
    try {
      const r = await runAgent({ notice, context_summary, candidates });
      log.model = r.model;
      log.provider = r.provider;
      const byId = Object.fromEntries(candidates.map(c => [c.id, c]));
      selected = r.selected.filter(s => byId[s.id]).slice(0, MAX_RETURN);
      note = selected.length ? '' : 'recall agent 看过候选池，没有真正相关的，空手而归。';
    } catch (e) {
      agent = 'error';
      log.error = String(e.message || e);
      note = `recall agent 调用失败（${log.error}），本轮安全返回空，不注入未经筛选的搜索结果。`;
      selected = [];
    }
  }
  log.agent = agent;
  log.returned = selected.length;
  log.returned_ids = selected.map(s => s.id);
  appendLog(log);
  // 只有纹理会升温；identity/profile 是稳定档案，不用靠访问次数改变权重。
  const touched = touch(selected.map(s => candidates.find(c => c.id === s.id)).filter(c => c && c.kind !== 'profile').map(c => c.id), 'recall');
  const byId = Object.fromEntries(touched.map(g => [g.id, g]));
  const memories = selected.map(s => {
    const g = byId[s.id] || candidates.find(c => c.id === s.id);
    if (g.kind === 'profile') return {
      id: g.id, layer: 'profile', kind: 'profile', category: g.category,
      owner: g.owner, owner_label: g.owner_label, field: g.field, field_label: g.field_label,
      text: g.text, updated_at: g.updated_at, reason: s.reason
    };
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
// 不配模型也会跑本地保守筛选；MUWEN_AUTORECALL_AGENT=1 表示“有可用 provider 时再加语义增强”。
// OpenAI 模式由 embedding 找候选、Luna 精选；外部服务没配好/临时故障时不会改烧 Claude，
// 也不会让整条自动召回失效。
// 琐碎消息（"嗯""好的""ok"、单字、纯标点）直接跳过，不浪费算力也不塞万金油。
// =====================================================

const TRIVIAL_PUNCT = /^[\s，。！？、~～.!?…·、：:;；'"''""()（）\-—]*$/;
const STOPWORDS = new Set(['嗯', '嗯嗯', '嗯呢', '好', '好的', '好呀', '好吧', '好的好的', '可以', '可以的', '好可以', '好的可以', '行', '行吧', '哦', '噢', '喔', '是', '是的', '对', '对的', '同意', '懂了', '知道了', '明白了', '继续', '继续吧', '你继续吧', '谢谢', '谢谢你', '收到', '在', '在的', '在呢', 'ok', 'okay', 'k', 'yes', 'no', '哈', '哈哈', '哈哈哈', '嘿嘿', '嗯嗯嗯', '晚安', '早', '早安']);
const CONTROL_MESSAGE = /^(?:\/loop\b|#\s*Autonomous loop tick\b|<<autonomous-loop|<task-notification\b|<system-reminder\b|<local-command\b|\[自动唤醒\])/i;

export function isTrivial(text) {
  const t = String(text || '').trim();
  if (t.length <= 1) return true;
  if (TRIVIAL_PUNCT.test(t)) return true;
  if (/^\d+$/.test(t)) return true;
  if (CONTROL_MESSAGE.test(t)) return true;
  // 用户常会在确认词后面带标点、波浪号或 emoji；这些仍是同一句“好的”，不该因为
  // 表面长度变长就翻记忆。只移除标点/符号/空白，不会误杀“疼吗？”这类短但有意义的话。
  const plain = t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (STOPWORDS.has(plain)) return true;
  if (/^(?:嗯+|哦+|噢+|喔+|哈+|嘿+|好+(?:的|呀|啊|吧|啦|嘞|哒)*|可以(?:的|呀|啊|吧|啦)*|行(?:的|呀|啊|吧|啦)*|对+(?:的|呀|啊|吧|啦)*|是+(?:的|呀|啊|吧|啦)*|懂了|知道了|明白了|收到|同意|没问题|谢谢(?:你)?|辛苦了|继续(?:吧)?|你继续(?:吧)?|ok+|okay+|yes+|no+)$/i.test(plain)) return true;
  if (/^(?:好的?|可以的?)(?:你)?继续(?:吧)?$/i.test(plain)) return true;
  return false;
}


// ---- 轻量 agent 模式：意图提取（query expansion，参考 LMC-5 Stage 0）----
// 关键词层的天花板是"换了说法就召不到"："你还记得我们的暗号吗" 里根本没有"项圈"两个字。
// 打开 MUWEN_AUTORECALL_AGENT=1 之后，每条非琐碎消息先跑一次模型，把消息改写成 2-4 个检索角度
// （关键实体 / 同义说法 / 情绪主题 / 指代还原），每个角度各搜一遍，按 id 合并取最高分。
// 只多一次模型调用——不是再跑一遍挑选 agent，那个是 recall() 干的事。
export const AUTORECALL_MODEL = recallModel('claude-opus-5', process.env.MUWEN_AUTORECALL_MODEL);
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
// 2026-11-14 从 20 提到 22：两周日志里关键词路径的非空返回 top_adj 分位 p10=22.7、p25=25.0，
// 提到 22 只少 5% 的返回，提到 24 要少 18%——先走一档，等有了"用上了没"的回执再定下一档。
const RELEVANCE_FLOOR = Number(process.env.MUWEN_RELEVANCE_FLOOR) || 22;
// 同一个分区最多占几条。三条结果全是 experience 的话，等于只从一个角度想起这件事——
// 强制最后一格留给别的分区（learning/agreement/年轮…）里分最高的那条。
// 凑不出别的分区就少给一条，不降格凑数。
function categoryCap(maxReturn) { return maxReturn >= 3 ? maxReturn - 1 : maxReturn; }
// 2026-11-14 从 5000 提到 8000：两周里精选 1920 次调用 949 次超时 / 失败（49%），5 秒对 gpt-6-luna 太紧。
// 现在精选和语义层并行跑，整体仍在钩子 15 秒预算内。
const INTENT_TIMEOUT_MS = Number(process.env.MUWEN_AUTORECALL_TIMEOUT_MS) || 8000;

const INTENT_SYSTEM = `你在给一个中文个人记忆库做检索词扩写。用户（棋子）发来一句话，你要结合最近对话判断"要不要翻记忆"，
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
- 最近对话是用来解析当前句子的，不是额外的检索素材。当前句子若只是在继续聊眼前的物件、颜色、体验或现场状态，必须 skip。
- 不要因为"喜欢、一般、好、东西、做"这类通用词联想旧记忆。检索角度必须和当前话题的具体实体或事件一致。
- 像"嗯……应该是喜欢的"这种依赖上文的短回复，如果上文是当下闲聊，必须 skip，不得拿"喜欢"去搜其他类别的记忆。
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

const AUTO_SELECT_SCHEMA = {
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

const AUTO_SELECT_SYSTEM = `你负责把中文私人记忆的候选结果做最后筛选。棋子刚说了一句话；候选可能来自关键词匹配，所以可能只是碰巧用了相同的字。

筛选原则：
- 这是自然联想，不要求棋子明确说“还记得吗”。普通但有意义的话也可能关联多段往事。
- 每一条都必须和她此刻说的具体人物、事件、地点、约定、感受或关系模式有真实联系；只共享一个普通词或泛泛情绪不算。
- 允许返回多条，但每条都要独立通过判断。没有相关的就返回空数组，绝不凑数。
- 区分计划、梦、玩笑、已经发生的事；区分旧状态和当前状态；主体不能张冠李戴。
- 如果候选已经被后来的记忆修正或否定，不要让旧说法单独冒出来误导。
- 只能返回候选池中真实存在的 id，按相关度排序。reason 用一句话说明具体联系。`;

export async function selectRelevant(query, candidates, { limit = 3, context = '', kind = '纹理' } = {}) {
  if (!candidates.length) return { selected: [], provider: recallProvider(), model: null };
  const compact = candidates.slice(0, Math.max(12, limit * 5)).map(candidate => ({
    id: candidate.id,
    date: candidate.date || undefined,
    category: candidate.category || candidate.window_name || kind,
    text: String(candidate.text || candidate.excerpt || '').slice(0, 700)
  }));
  const user = [
    `棋子刚说：${query}`,
    context ? `当前对话已有信息：${context}` : '',
    `最多返回 ${limit} 条。`,
    `${kind}候选池：${JSON.stringify(compact)}`
  ].filter(Boolean).join('\n');
  const response = await generateStructured({
    model: AUTORECALL_MODEL, anthropicDefault: 'claude-opus-5', maxTokens: 900,
    timeoutMs: INTENT_TIMEOUT_MS, system: AUTO_SELECT_SYSTEM, user,
    schema: AUTO_SELECT_SCHEMA, effort: 'low'
  });
  const ids = new Set(compact.map(candidate => candidate.id));
  const selected = (Array.isArray(response.data.selected) ? response.data.selected : [])
    .filter(item => item && ids.has(item.id)).slice(0, limit);
  return { selected, provider: response.provider, model: response.model };
}

export async function extractIntent(message, context = '') {
  // classifier 是辅助层，不做自动重试，避免卡住整轮回复。生产 provider 失败时上层安全返回空。
  const user = [
    context ? `【最近对话（只用于理解指代和当前话题）】\n${String(context).slice(-5000)}` : '',
    `【当前消息】\n${String(message)}`
  ].filter(Boolean).join('\n\n');
  const res = await generateStructured({
    model: AUTORECALL_MODEL, anthropicDefault: 'claude-opus-5', maxTokens: 700,
    timeoutMs: INTENT_TIMEOUT_MS, system: INTENT_SYSTEM, user,
    schema: INTENT_SCHEMA, effort: 'low'
  });
  const parsed = res.data;
  return {
    skip: !!parsed.skip,
    intent: parsed.intent === 'answer' ? 'answer' : 'association',
    queries: Array.isArray(parsed.queries) ? parsed.queries.map(String).filter(Boolean).slice(0, 4) : [],
    why: String(parsed.why || ''),
    model: res.model,
    provider: res.provider
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

// identity/profile 是稳定档案，但每次只让跟当前话题命中的短片段进入候选池。
// 这里与纹理使用同一套长度归一化思路，避免一份很长的 profile 靠零散字词刷分。
export function searchProfileMemories(query, { limit = 12, minScore = 6 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const hits = [];
  for (const entry of profileRecallEntries()) {
    const raw = score(q, entry.text);
    if (raw < minScore) continue;
    let sub = 0;
    for (let n = Math.min(6, q.length); n >= 3 && !sub; n--) {
      for (let i = 0; i + n <= q.length; i++) {
        if (entry.text.includes(q.slice(i, i + n))) { sub = n * 4; break; }
      }
    }
    hits.push({ ...entry, score: raw, _adj: (raw + sub) / (1 + entry.text.length / 800) });
  }
  return hits.sort((a, b) => b._adj - a._adj).slice(0, limit);
}

// autoMode：钩子那条路（/api/recall）才开——短话 / 电话 / 系统事件整个不召回，13–20 字不开语义层。
// 辞自己调 auto_recall 工具是"特意来找"，不受这些准入限制。
export async function autoRecall(query, { maxReturn: maxReturnOpt = null, minScore = 6, suppressRecent = true, useAgent = null, context = '', touchHits = false, excludeIds = [], queries = null, useSemantic = null, autoMode = false, origin = '', _semanticPick = null, _pickRings = null, _intent = null, _selectRelevant = null } = {}) {
  const t0 = Date.now();
  const q = String(query || '').trim();
  // 提到了谁：名字是精确的，不用走打分，直接把人卡 + 最近的八卦带上。不占 maxReturn 的名额。
  let people = [];
  try { people = mentionedPeople(q); } catch { /* 人卡读坏了不影响正常召回 */ }
  if (isTrivial(q)) return { query: q, trivial: true, memories: [], layers_used: people.length ? ['social'] : [], angles: [], people };
  if (autoMode) {
    const reason = skipReason(q, { people, origin });
    if (reason) {
      appendLog({ id: newId('ar'), auto: true, skipped: reason, notice: q, returned: 0, returned_ids: [], layers: [], created_at: now() });
      return { query: q, skipped: reason, memories: [], layers_used: [], angles: [], people: reason === 'short' ? people : [] };
    }
    // 还在聊刚召回过的那个话题 → 这次不再召（30 分钟压制只挡"同几条"，这里挡的是"同一件事"）
    if (suppressRecent && sameTopicRecently(q, context, { askedHistory: isHistoryAsk(q) })) {
      appendLog({ id: newId('ar'), auto: true, skipped: 'same_topic', notice: q, returned: 0, returned_ids: [], layers: [], created_at: now() });
      return { query: q, skipped: 'same_topic', memories: [], layers_used: people.length ? ['social'] : [], angles: [], people };
    }
  }
  const exclude = new Set(excludeIds || []);
  const layersUsed = [];
  // 先用本地正则判一道；开了 agent 的话下面模型还会再判一道
  let askedHistory = isHistoryAsk(q);
  let maxReturn = ASSOC_MAX;

  // 便签层先算——它不能被下面的"要不要翻记忆"挡住。
  // 便签是他自己写的**当下**（sticky 铁律、today 待办），不是回忆：
  // 意图 agent 判"这是操作指令、跟历史记忆无关"是对的，但恰恰是这种时候，
  // 手头那条铁律/待办才最该出来。实测"备份"就是这么被整轮掐掉的。
  // 关键词那层已经卡了覆盖率，宁可空手，所以放行不会带进垃圾。
  let noteHits = [];
  try {
    noteHits = searchNotes(q, { limit: 3 }).map(n => ({ cat: 'note', m: {
      layer: 'notebook', kind: 'note', id: n.id, section: n.section, text: n.text,
      date: (n.at || '').slice(0, 10) || undefined, tags: n.tags, score: n.score, coverage: n.coverage
    } }));
  } catch { /* 便签没同步过/读坏了不影响正常召回 */ }
  if (noteHits.length) layersUsed.push('notebook');
  // OpenAI 向量模式通常不跑意图扩写，但这类依赖上文的短回复最容易被“喜欢/一般”
  // 等通用词带偏。上下文明确存在时先保守跳过旧记忆；真正命中的当下便签仍可返回。
  if (isContextualShortContinuation(q, context)) {
    return {
      query: q,
      skipped_by_context: true,
      why: '当前消息是依赖最近对话的短回复',
      memories: noteHits.slice(0, 2).map(x => x.m),
      layers_used: noteHits.length ? ['notebook'] : [],
      angles: []
    };
  }
  const agent = useAgent === null ? (process.env.MUWEN_AUTORECALL_AGENT === '1') : useAgent;
  // agent 是“想开智能层”；modelAgent 才是“这一轮真的有可用模型”。测试接缝单独放行，
  // 生产没有 provider 时直接走本地层，不先制造一次必然失败的网络调用。
  let modelAgent = agent && providerReady();

  // embedding 本身已经能跨同义词找候选。OpenAI 模式默认不再为“扩写几个关键词”额外
  // 调一次模型：弱匹配时直接向量检索，省一半延迟和生成费用。需要做对照实验时可显式打开。
  const intentExpansion = recallProvider() !== 'openai' || process.env.MUWEN_OPENAI_INTENT_EXPANSION === '1';

  // 检索角度：原句永远算一个（保住精确匹配），agent 模式下再加模型扩写出来的 2-4 个。
  let angles = [q];
  let via = 'search';
  let intentWhy = '';
  if (Array.isArray(queries) && queries.length) {          // 调用方直接给角度（测试/钩子预扩写用）
    angles = [q, ...queries.map(String)]; via = 'given';
  } else if (agent && ((modelAgent && intentExpansion) || _intent)) {
    try {
      const intent = await (_intent || extractIntent)(q, context);
      intentWhy = intent.why;
      if (intent.intent === 'answer') askedHistory = true;
      if (intent.skip && !intent.queries.length) {
        // 记忆不翻了，但当下的便签该给还是给
        return { query: q, skipped_by_agent: true, why: intentWhy,
          memories: noteHits.slice(0, 2).map(x => x.m),
          layers_used: noteHits.length ? ['notebook'] : [], angles: [] };
      }
      angles = [q, ...intent.queries];
      via = 'intent-agent';
    } catch (e) {
      intentWhy = String(e.message || e);
      // provider 临时失败也继续走本地保守层。后面仍有 20 分相关性硬门槛，不会把原始候选
      // 不加筛选地塞进上下文；只失去“换一种说法也能联想到”的语义能力。
      modelAgent = false;
      via = 'local-fallback';
    }
  } else if (agent) {
    via = modelAgent && recallProvider() === 'openai' ? 'vector-ready' : 'local';
  }
  // 前几句里的锚点和当前句组一条查询（原句永远保留）。问历史口吻不组——"上次那个方案"要的是旧事，不是眼前这个话题。
  const ctxAnchors = autoMode && context && !askedHistory ? contextAnchors(context).filter(a => !q.includes(a)) : [];
  if (ctxAnchors.length) angles.push(`${q} ${ctxAnchors.join(' ')}`);
  angles = [...new Set(angles.map(a => a.trim()).filter(Boolean))];
  // 排序加权用：前几句的双字集合。问历史时不加权。
  const ctxGrams = autoMode && context && !askedHistory ? bigrams(contextLines(context).join(' ')) : new Set();

  // 自然联想 3 条、查历史 6 条。调用方显式传了就听调用方的。
  maxReturn = maxReturnOpt || (askedHistory ? HISTORY_MAX : ASSOC_MAX);
  // 30 分钟内浮现过的这轮不再出现——除非她正在主动问历史
  const recent = (askedHistory || !suppressRecent) ? new Set() : recentlySurfaced();

  // 稳定档案层：identity/profile 也能被召回，但只取短片段。普通联想最多占 1 条，
  // 明确查历史时最多 2 条，避免档案把三条自然联想全部挤满。
  const profileMerged = new Map();
  for (const a of angles) {
    for (const p of searchProfileMemories(a, { limit: Math.max(maxReturn * 4, 12), minScore })) {
      if (exclude.has(p.id)) continue;
      const prev = profileMerged.get(p.id);
      if (prev) { prev._adj = Math.max(prev._adj, p._adj) + 1; prev._angles.push(a); }
      else profileMerged.set(p.id, { ...p, _angles: [a] });
    }
  }
  const profileLimit = askedHistory ? 2 : 1;
  let profileHits = [...profileMerged.values()]
    .filter(p => p._adj >= RELEVANCE_FLOOR)
    .sort((a, b) => b._adj - a._adj)
    .slice(0, profileLimit * 3);
  if (profileHits.length) layersUsed.push('profiles');

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
  // ③ 和前几句沾得上的候选往前排：前几句的双字里有几成出现在这条纹理里，最多加 CONTEXT_RANK_WEIGHT 分
  if (ctxGrams.size) for (const g of merged.values()) { const c = containment(ctxGrams, bigrams(g.text)); if (c) { g._adj += CONTEXT_RANK_WEIGHT * c; g._ctx = Math.round(c * 100) / 100; } }
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

  const tKeyword = Date.now();
  const topAdj = Math.max(picked.length ? picked[0]._adj : 0, profileHits.length ? profileHits[0]._adj : 0);
  // 相关性下限：关键词纹理里分不够的直接不要。语义层挑的不过这条线——
  // 那是模型读完索引挑的，本来就没有关键词分数，而且它被交代过"宁可空手不硬塞"。
  const dropped = picked.filter(g => g._adj < RELEVANCE_FLOOR).length;
  picked = picked.filter(g => g._adj >= RELEVANCE_FLOOR);

  // 第二层（语义兜底）和精选并行（2026-11-14 改）。以前是 语义层(12s) → 精选(5s) → 精选全空再语义层一次，
  // 串着跑；两周日志里精选 49% 超时失败、问历史口吻实测 25 秒。现在：
  //   · 语义层：关键词顶分 < SEMANTIC_FLOOR 时必跑（"你还记得我们的暗号吗"这种换了说法的靠它接住）；
  //     精选可能把关键词全否掉的时候**顺带**也跑一次，省得事后再等一轮——但只在精选真的全否了才采用；
  //   · 精选：所有过了相关性下限的关键词纹理再过一次模型，允许多条，不相关的一条也不凑；
  //   · 两个同时发出去，各自 8 秒上限，谁挂了都退回本地保守层，不让整套失声。
  // autoMode 下 13–20 字、没锚点、不问历史、没提到人的话不开语义层——两周里这一档召回出来的 67% 只靠语义层，
  // 字面一个词都没对上，就是棋子说的"不准确"。
  const semanticAllowed = !autoMode || askedHistory || q.replace(/\s+/g, '').length > SEMANTIC_MIN_LEN || hasAnchor(q) || people.length > 0;
  const semanticOn = (useSemantic === null
    ? (agent && process.env.MUWEN_AUTORECALL_SEMANTIC !== '0' && (modelAgent || _semanticPick || _pickRings))
    : (!!useSemantic && (modelAgent || _semanticPick || _pickRings))) && semanticAllowed;
  const semanticNeeded = semanticOn && topAdj < SEMANTIC_FLOOR;
  const selectorOn = agent && (modelAgent || _selectRelevant) && picked.length > 0;
  const semanticSpeculative = semanticOn && !semanticNeeded && selectorOn;
  let semantic = null;
  let selector = null;
  const viaBase = via;
  const tModels0 = Date.now();
  const semanticTask = (semanticNeeded || semanticSpeculative)
    ? (async () => {
        const pick = _semanticPick || semanticPick;   // _semanticPick 是测试接缝，正常不传
        // 向量用"当前句×2 + 前几句"合成文本（当前句权重高）；问历史口吻只用当前句
        const embedText = autoMode && context && !askedHistory ? [q, q, ...contextLines(context)].join('\n').slice(0, 1500) : q;
        return pick(q, { limit: maxReturn, excludeIds: semanticNeeded ? [...picked.map(g => g.id), ...profileHits.map(p => p.id)] : [], context, embedText });
      })().then(r => ({ ok: true, r }), e => ({ ok: false, e }))
    : null;
  const selectorTask = selectorOn
    ? (async () => {
        const select = _selectRelevant || selectRelevant;
        return select(q, picked, { limit: maxReturn, context, kind: '纹理' });
      })().then(r => ({ ok: true, r }), e => ({ ok: false, e }))
    : null;
  const [semRes, selRes] = await Promise.all([semanticTask, selectorTask]);
  const tModels = Date.now();
  let selectorSuffix = '';
  if (selRes) {
    if (selRes.ok) {
      selector = selRes.r;
      const byId = new Map(picked.map(item => [item.id, item]));
      picked = selector.selected.map(item => {
        const memory = byId.get(item.id);
        return memory ? { ...memory, _reason: item.reason } : null;
      }).filter(Boolean);
      selectorSuffix = '+rerank';
    } else {
      intentWhy = (intentWhy ? intentWhy + '；' : '') + `最终筛选失败：${selRes.e?.message || selRes.e}`;
      // 精选层挂了，保留已经通过本地强相关门槛的结果；绝不因为外部 API 故障让自动召回整套失声。
      modelAgent = false;
      selectorSuffix = '+local-fallback';
    }
  }
  let semanticMemories = [];
  if (semRes && !semRes.ok) {
    intentWhy = (intentWhy ? intentWhy + '；' : '') + `语义层失败：${semRes.e?.message || semRes.e}`;
  } else if (semRes && semRes.r.picks.length && (semanticNeeded || !picked.length)) {
    // 关键词本来就不准（needed）→ 语义层挑的排前面；精选把关键词全否了 → 用顺带跑出来的那份
    semantic = semRes.r;
    semanticMemories = semantic.picks;
    layersUsed.push('semantic');
  }
  via = semantic && semanticNeeded
    ? (viaBase === 'intent-agent' ? 'intent+semantic' : 'semantic') + selectorSuffix
    : viaBase + selectorSuffix + (semantic ? '+semantic' : '');
  if (semanticMemories.some(m => m.kind === 'profile' || m.layer === 'profile') && !layersUsed.includes('profiles')) layersUsed.push('profiles');

  // 第三层：只有她明确在查历史、且前两层没给出像样的东西时，才翻年轮找线索
  // （last_resort，只当参考不当权威）。普通联想绝不直接打开原始聊天记录：年轮体量太大，
  // 容易把一句闲聊变成"忽然倒出一大坨旧内容"，也会多花一次筛选调用。
  // 门槛跟语义层同一条线（topAdj < SEMANTIC_FLOOR），不是"必须一条都没搜到"——
  // 库里两百多条纹理、中文又是按字匹配，关键词层几乎总能搜出点沾边的东西来。
  let rawHits = [];
  let ringSemantic = null;
  if (askedHistory && !semanticMemories.length && topAdj < SEMANTIC_FLOOR) {
    for (const a of angles) {
      rawHits.push(...searchRings({ query: a, limit: 5 }).filter(r => r.score >= minScore));
    }
    rawHits = [...new Map(rawHits.map(r => [r.id, r])).values()]
      // 覆盖率过不了线的一律扔掉——留着只会拿一段毫不相干的原文占位置。
      .filter(r => (r.coverage || 0) >= RING_COVERAGE_FLOOR)
      .sort((a, b) => b.score - a.score);
    if (rawHits.length) layersUsed.push('rings');

    // 关键词也没在年轮里搜到——让模型读年轮索引按意思挑一遍（这是最后一次机会，不是额外加塞）。
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

  // 按优先级排好的候选池：便签 > 语义层挑的 > 关键词纹理 > 年轮线索。
  const candidatePool = [
    ...noteHits,
    ...profileHits.map(p => ({ cat: `profile:${p.owner}:${p.field}`, m: {
      layer: 'profile', kind: 'profile', id: p.id, category: p.category,
      owner: p.owner, owner_label: p.owner_label, field: p.field, field_label: p.field_label,
      text: p.text, updated_at: p.updated_at, score: p.score,
      adj: Math.round(p._adj * 10) / 10, matched_angles: p._angles
    } })),
    ...semanticMemories.map(m => ({ cat: m.category || (m.layer === 'notebook' ? 'note' : 'semantic'), m })),
    ...picked.map(g => ({ cat: g.category, m: {
      layer: 'authority', kind: 'grain', id: g.id, category: g.category, text: g.text,
      date: g.date || undefined, heat: Math.round(g.heat), confidence: g.confidence,
      score: g.score, adj: Math.round(g._adj * 10) / 10, matched_angles: g._angles,
      ...(g._reason ? { reason: g._reason } : {})
    } })),
    ...rawHits.map(r => ({ cat: 'ring', m: {
      layer: 'last_resort', kind: 'ring', id: r.id, window_name: r.window_name,
      date: r.date, excerpt: r.excerpt, score: r.score,
      ...(r.reason ? { reason: r.reason, via: r.via } : {})
    } }))
  ];
  // 记忆库里即便误收进了 state.json / 配置快照一类机器数据，也不能自动灌给辞。
  // 真要查看系统状态应由对应工具按需读取，而不是把整份序列化文件当成“回忆”。
  const pool = candidatePool.filter(({ m }) => !looksLikeSystemDump(m.text || m.excerpt || ''));
  const systemSuppressed = candidatePool.length - pool.length;

  // 分区多样性 + 去重。候选按优先级顺序贪心取，所以"第三格换个分区"自然就是
  // "其他分区里排最前的那条"；近似重复的只留排在前面那条（排前面的分更高）。
  const cap = categoryCap(maxReturn);
  const used = {};
  const memories = [];
  const seenIds = new Set();
  const seenGrams = [];
  let duplicates = 0;
  let suppressed = 0;
  let profilesUsed = 0;
  for (const { cat, m } of pool) {
    if (memories.length >= maxReturn) break;
    if (seenIds.has(m.id)) continue;                     // 同一条被两层各召回一次
    if (recent.has(m.id)) { suppressed++; continue; }    // 半小时内刚浮现过，别又端一遍
    if ((m.kind === 'profile' || m.layer === 'profile') && profilesUsed >= profileLimit) continue;
    if ((used[cat] || 0) >= cap) continue;
    // 同一件事写过浓缩版和完整版的不少，两条一起返回等于浪费一个名额
    const grams = bigrams(m.text || m.excerpt || '');
    if (seenGrams.some(prev => nearDuplicate(prev, grams))) { duplicates++; continue; }
    seenIds.add(m.id);
    seenGrams.push(grams);
    used[cat] = (used[cat] || 0) + 1;
    if (m.kind === 'profile' || m.layer === 'profile') profilesUsed++;
    memories.push(m);
  }

  // 真注进去的纹理（关键词层和语义层挑的都算）才升温；档案 / 便签 / 年轮不升温
  const returnedGrainIds = memories.filter(m => m.kind === 'grain').map(m => m.id);
  if (touchHits && returnedGrainIds.length) touch(returnedGrainIds, 'recall');

  try {
    appendLog({ id: newId('ar'), auto: true, notice: q, via, angles, why: intentWhy || undefined,
      top_adj: topAdj || undefined,
      semantic: semantic ? { picked: semanticMemories.length, index: semantic.index_count, model: semantic.model,
        vector: semantic.vector, cache: semantic.cache } : undefined,
      selector: selector ? { provider: selector.provider, model: selector.model, picked: picked.length } : undefined,
      below_floor: dropped || undefined,
      duplicates: duplicates || undefined,
      suppressed: suppressed || undefined,
      system_suppressed: systemSuppressed || undefined,
      intent: askedHistory ? 'answer' : 'association',
      ring_semantic: ringSemantic ? { picked: ringSemantic.picks.length, index: ringSemantic.index_count, model: ringSemantic.model, cache: ringSemantic.cache } : undefined,
      people: people.length ? people.map(x => x.matched) : undefined,
      ms: { total: Date.now() - t0, keyword: tKeyword - t0, models: tModels - tModels0 },
      context: context ? { lines: contextLines(context).length, anchors: ctxAnchors.length ? ctxAnchors : undefined } : undefined,
      returned: memories.length, returned_ids: memories.map(m => m.id), layers: layersUsed, created_at: now() });
  } catch { /* 日志失败不影响返回 */ }

  if (people.length) layersUsed.unshift('social');
  return { query: q, via, angles, why: intentWhy || undefined, memories, layers_used: layersUsed, people,
    intent: askedHistory ? 'answer' : 'association', max_return: maxReturn,
    categories: Object.keys(used), below_floor: dropped || undefined,
    duplicates: duplicates || undefined, suppressed: suppressed || undefined,
    system_suppressed: systemSuppressed || undefined,
    ...(selector ? { selector: { provider: selector.provider, model: selector.model, picked: picked.length } } : {}),
    ...(semantic ? { semantic: { index_count: semantic.index_count, truncated: semantic.truncated, model: semantic.model,
      vector: semantic.vector, cache: semantic.cache } } : {}),
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

// 自动召回不是文件查看器。只拦明显的“大段序列化对象”，普通谈话里提到 state.json、
// 或短小的代码/配置片段不会被误伤。
function looksLikeSystemDump(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (t.length < 400 || !/^[\[{]/.test(t)) return false;
  try {
    const parsed = JSON.parse(t);
    return !!parsed && typeof parsed === 'object';
  } catch {
    const keys = t.match(/"[^"\n]{1,80}"\s*:/g) || [];
    return keys.length >= 8;
  }
}

// 把 autoRecall 结果拼成给钩子注入的文本（带 [muwen:recall] 前缀，配合阅后即焚 hook 清理旧的）。
// 总量卡在 INJECT_BUDGET（默认 900 字）：装不下的宁可不给，也不要把她的上下文占掉一大块。
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
    if (looksLikeSystemDump(m.text || m.excerpt || '')) { dropped++; continue; }
    if (m.layer === 'semantic') {
      const conf = m.confidence === 'cite' ? '' : '（记得不太牢，留点余地）';
      push(`· [语义·${m.category}·heat${m.heat}] ${m.date ? m.date + ' ' : ''}${fragment(q, m.text, 160)}${conf}${m.reason ? `　← ${m.reason}` : ''}`);
    } else if (m.layer === 'notebook') {
      // 便签是他自己写的当下，不是回忆——标清楚来源，别让辞当成旧事引用
      push(`· [便签·${m.section}${m.date ? '·' + m.date : ''}] ${fragment(q, m.text, 160)}${m.reason ? `　← ${m.reason}` : ''}`);
    } else if (m.layer === 'profile' || m.kind === 'profile') {
      // 档案不是旧事，单独标出来；每条仍只给一个短片段，不泄洪整份 identity/profile。
      push(`· [档案·${m.owner_label || m.owner || ''}·${m.field_label || m.field || ''}] ${fragment(q, m.text, 180)}${m.reason ? `　← ${m.reason}` : ''}`);
    } else if (m.layer === 'last_resort') {
      const why = m.reason ? `　← ${m.reason}` : '';
      // 年轮片段比纹理给得长一点——它是原文线索，太短了看不出在说什么
      push(`· [年轮·线索] ${m.date || ''} ${m.window_name || ''}：${fragment(q, m.excerpt || '', 180)}${why}`);
    } else {
      const conf = m.confidence === 'cite' ? '' : (m.confidence === 'cautious' ? '（记得不太牢，留点余地）' : '（很淡，仅供参考）');
      push(`· [${m.category}·heat${m.heat}] ${m.date ? m.date + ' ' : ''}${fragment(q, m.text, 160)}${conf}`);
    }
  }
  if (dropped) {
    const note = `（还有 ${dropped} 条没放进来，超字数了）`;
    if (used + note.length + 1 <= INJECT_BUDGET + note.length) lines.push(note);
  }
  return lines.join('\n');
}
