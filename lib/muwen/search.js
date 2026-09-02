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
