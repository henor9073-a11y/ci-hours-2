// 关键词搜索（第一版）。设计文档里说的语义/向量搜索是后续优化，不阻塞这一版。
// 中文没有空格分词，这里用"字 + 相邻两字（bigram）"当 token；英文按单词。
// 打分：query 的每个 token 在文本里出现就加分，bigram 比单字权重高，整句子串命中再加一大截。
// "像"不等于"相关"——这是搜索层的天花板，真正挑哪条是 recall agent 的事（见 recall.js）。

const CJK = /[㐀-鿿]/;

export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = new Set();
  let cjkRun = '';
  const flushCjk = () => {
    if (!cjkRun) return;
    for (let i = 0; i < cjkRun.length; i++) {
      tokens.add(cjkRun[i]);
      if (i + 1 < cjkRun.length) tokens.add(cjkRun.slice(i, i + 2));
    }
    cjkRun = '';
  };
  let word = '';
  const flushWord = () => { if (word.length >= 2) tokens.add(word); word = ''; };
  for (const ch of s) {
    if (CJK.test(ch)) { flushWord(); cjkRun += ch; }
    else if (/[a-z0-9]/.test(ch)) { flushCjk(); word += ch; }
    else { flushCjk(); flushWord(); }
  }
  flushCjk(); flushWord();
  return tokens;
}

// 给一段文本打分。返回 0 表示完全没沾边。
export function score(query, text) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return 0;
  const t = String(text || '').toLowerCase();
  if (!t) return 0;
  let s = 0;
  if (t.includes(q)) s += 20; // 整句命中
  const qt = tokenize(q);
  const singleOk = q.length === 1; // 只有 query 本身就是一个字的时候才按单字算，不然"的""了"会把所有东西都命中
  for (const tok of qt) {
    if (!t.includes(tok)) continue;
    if (tok.length === 1 && CJK.test(tok)) { if (singleOk) s += 3; }
    else if (tok.length === 2 && CJK.test(tok)) s += 3; // 两字词
    else s += 2;                                         // 英文单词
  }
  return s;
}

// ---- 段级打分 ----
// 整篇打分对年轮不管用：一篇十几万字的窗口转储，靠零散双字在全篇各处刷分，
// 能盖过真正记着这件事的那条短记录。真正该问的是"这篇里最相关的那一段有多相关"，
// 而不是"这篇总共沾了多少边"——所以滑动窗口逐段打分，取最高的那一段。
// 白送的好处：赢的那一段本身就是要返回的 excerpt，正好是命中处前后几句话。
export const PASSAGE_WINDOW = Number(process.env.MUWEN_PASSAGE_WINDOW) || 500;
export const PASSAGE_STEP = Number(process.env.MUWEN_PASSAGE_STEP) || 250;

// 步长取窗口的一半，保证任何一句话都完整地落在至少一个窗口里，
// 不会因为正好卡在边界上被劈成两半而丢分。
export function bestPassage(query, text, { window = PASSAGE_WINDOW, step = PASSAGE_STEP } = {}) {
  const t = String(text || '');
  if (!t) return { score: 0, start: 0, end: 0 };
  if (t.length <= window) return { score: score(query, t), start: 0, end: t.length };
  let best = { score: 0, start: 0, end: Math.min(window, t.length) };
  for (let i = 0; i < t.length; i += step) {
    const end = Math.min(i + window, t.length);
    const s = score(query, t.slice(i, end));
    if (s > best.score) best = { score: s, start: i, end };
    if (end >= t.length) break;
  }
  return best;
}

// 覆盖率：这一段拿到的分，占"完美命中能拿到的分"（query 跟自己比）的几成。
// 用它当门槛而不是用绝对分数——绝对分数会被查询本身的长度带跑：
// "我家狗要不要打麻药洗牙那件事后来怎么样了" 里 要不要/那件事/怎么样 这类废话到处都是，
// 绝对分能刷到 18，但占比只有 0.23；真命中的占比在 0.44 以上。实测这两组之间有明显空档。
export function coverage(query, passageScore) {
  const self = score(query, query);
  return self > 0 ? passageScore / self : 0;
}

// ---- 近似重复 ----
// 同一件事写过两遍的纹理不少（浓缩版 + 完整版），召回时两条一起返回等于浪费一个名额，
// 读起来也像结巴。用双字集合判重。
//
// 度量选的是 containment（小集合被大集合包住的比例），不是 Jaccard——
// 实测那两条"项圈暗号的来源"（164 字的浓缩版 vs 543 字的完整版）Jaccard 只有 0.19，
// 被长文多出来的内容稀释掉了，抓不住；containment 是 0.65。
// 但 containment 单用会翻车：一条 1000 字的纹理能把 34 字的短纹理"包住"到 0.79，
// 纯属巧合。所以再加一道体量比的护栏，两条长度差太多的根本不比。
// 阈值是拿 303 条真实纹理量出来的：0.6/0.2 命中 33/30135 对，抽查基本都是真重复；
// 放到 0.5 就开始混进"Sei与Cy的同步性"vs"紫色"这种只是共用几个词的。
const DUP_MIN_BIGRAMS = 20;   // 太短的不比——十几个双字里撞上几个纯属偶然
const DUP_SIZE_RATIO = Number(process.env.MUWEN_DUP_SIZE_RATIO) || 0.2;
const DUP_CONTAINMENT = Number(process.env.MUWEN_DUP_CONTAINMENT) || 0.6;

export function bigrams(text) {
  return new Set([...tokenize(text)].filter(t => t.length === 2));
}

export function nearDuplicate(a, b) {
  if (!a || !b || a.size < DUP_MIN_BIGRAMS || b.size < DUP_MIN_BIGRAMS) return false;
  const small = a.size < b.size ? a : b;
  const large = a.size < b.size ? b : a;
  if (small.size / large.size < DUP_SIZE_RATIO) return false;
  let hit = 0;
  for (const t of small) if (large.has(t)) hit++;
  return hit / small.size >= DUP_CONTAINMENT;
}

// ---- 句子边界 ----
// 摘录切在半句话中间很难读（"…我指错了几次路，被她说"）。下面两个函数负责
// 让摘录尽量从一句话的开头起、到一句话的结尾止。
// 只在"不会因此丢掉太多内容"的前提下才切——宁可留个半句，也不要为了齐整
// 把命中处本身给切没了。
const SENT_END = /[。！？!?…；;\n]["'』」）)]*/g;

// 引号配平检查。光看句号会截在引号中间：
//   棋子说"0/10。我不会把你扔进垃圾桶。"
// 那个"0/10。"后面的句号确实是句子结尾，但它在引号里，截在那儿会留一个
// 悬空的开引号，读起来就像话说了一半。所以截断点还得让引号是配平的。
const QUOTE_PAIRS = [['\u201c', '\u201d'], ['\u300c', '\u300d'], ['\u300e', '\u300f'], ['\uff08', '\uff09']];
function countOf(t, ch) { let n = 0; for (const c of t) if (c === ch) n++; return n; }
export function quoteBalanced(t) {
  const s = String(t || '');
  if (countOf(s, '"') % 2 !== 0) return false;      // 直引号只能数奇偶
  for (const [open, close] of QUOTE_PAIRS) {
    if (countOf(s, open) !== countOf(s, close)) return false;
  }
  return true;
}

// 找出所有句子结束位置（返回的是"结束之后"的下标）
function sentenceEnds(t) {
  const out = [];
  SENT_END.lastIndex = 0;
  let m;
  while ((m = SENT_END.exec(t)) !== null) out.push(m.index + m[0].length);
  return out;
}

// 掐掉头尾的半句。head 取前 25% 以内的最后一个句号（取第一个的话，
// "…t.\n```\n\nPanda 平时…" 这种只会掐掉开头那个省略号，垃圾还在）；
// 范围收在 25% 是因为命中处可能就在段落靠前的位置，掐太多会把它掐没。
// tail 只在保留 60% 以上的前提下才掐。
export function trimToSentences(text) {
  const t = String(text || '');
  if (t.length < 40) return t;
  const ends = sentenceEnds(t);
  let start = 0, end = t.length;
  const headCut = [...ends].reverse().find(e => e <= t.length * 0.25);
  if (headCut !== undefined) start = headCut;
  // 尾巴优先切在"引号配平"的地方；一个都没有就退回原来的规则，
  // 总比整段不切要好——切在引号中间只是难看，不切是几百字倒出来。
  const cands = [...ends].reverse().filter(e => e > start && (e - start) >= (end - start) * 0.6);
  const tailCut = cands.find(e => quoteBalanced(t.slice(start, e))) ?? cands[0];
  if (tailCut !== undefined) end = tailCut;
  return t.slice(start, end).trim();
}

// 截到 limit 以内，且尽量停在句子结尾。找不到合适的句号就硬切并加省略号。
export function clipToSentence(text, limit) {
  const t = String(text || '').trim();
  if (t.length <= limit) return t;
  const head = t.slice(0, limit);
  const cands = [...sentenceEnds(head)].reverse().filter(e => e >= limit * 0.5);
  // 先找引号配平的截断点，找不到再退而求其次用最后一个句号，再不行硬切。
  const cut = cands.find(e => quoteBalanced(t.slice(0, e))) ?? cands[0];
  return cut !== undefined ? t.slice(0, cut).trim() : head.trim() + '…';
}

// 命中处附近的一小段，给列表/搜索结果用，别把几万字原文整个倒出来。
export function excerpt(text, query, radius = 120) {
  const t = String(text || '');
  const q = String(query || '').toLowerCase();
  let idx = q ? t.toLowerCase().indexOf(q) : -1;
  if (idx === -1 && q) {
    // 整句没命中就找分数最高的 bigram
    for (const tok of tokenize(q)) {
      if (tok.length < 2) continue;
      idx = t.toLowerCase().indexOf(tok);
      if (idx !== -1) break;
    }
  }
  if (idx === -1) return t.length > 2 * radius ? t.slice(0, 2 * radius) + '…' : t;
  const start = Math.max(0, idx - radius);
  const end = Math.min(t.length, idx + radius);
  return (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '');
}
