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
