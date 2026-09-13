// 把年轮原文拆成一句一句的对话，给"像微信聊天记录那样翻"用。
// 原文是好几个时期、好几种导出方式攒下来的，说话人前缀不统一：
//   [00:03] 棋子: …        GPD jsonl 自动导出
//   棋子：… / 辞：…         手动整理的（全角冒号）
//   USER: … / ASST: …      早期导出；USER[2026-08-30T12:28:05]: 带时间
// 所以只认白名单里的名字——正文里 "方案：" "\"id\":" 这种冒号行太多了，放开认就全乱。
// 拆不出任何说话人的记录（叙述体、纪要）原样当文档给，不硬拆。

const NOR_NAMES = ['棋子', '奈々キ', 'Nor', 'nor', 'NOR', 'USER', 'User', 'user', 'Human', 'human', '用户'];
const CY_NAMES = ['辞', 'Cy', 'cy', 'CY', 'ASST', 'Assistant', 'assistant', 'Claude', 'claude'];
const NAME_RE = [...NOR_NAMES, ...CY_NAMES].sort((a, b) => b.length - a.length).join('|');
// 行首：可选 [HH:MM] → 名字（可能包在 [辞] 或 **辞** 里）→ 可选 [时间戳] → 半角或全角冒号
const SPEAKER_RE = new RegExp(`^[ \\t]*(?:\\[(\\d{1,2}:\\d{2})(?::\\d{2})?\\][ \\t]*)?(?:\\*\\*|\\[)?(${NAME_RE})(?:\\*\\*|\\])?(?:\\[([^\\]\\n]{4,32})\\])?[ \\t]*[:：][ \\t]?`, 'gm');

const THINK_MARK = /^\s*[（(]\s*思考\s*[)）]\s*/;
const TOOL_LINE = /^\s*[［\[]\s*调用(?:工具)?\s*([^\]］\n]*)[\]］]\s*$/;
const RESULT_LINE = /^\s*[［\[]\s*(?:工具)?结果\s*[\]］]\s*(.*)$/;

function speakerOf(name) { return NOR_NAMES.includes(name) ? 'nor' : 'cy'; }

// 思考过程是英文的，回复是中文的——（思考）后面连续的"英文为主"的行算思考，
// 碰到第一行中文为主的就是正文开始了。思考本身是中文的分不出来，那就不拆，原样当正文。
function isReasoningLine(line) {
  const latin = (line.match(/[A-Za-z]/g) || []).length;
  const cjk = (line.match(/[\u3400-\u9fff]/g) || []).length;
  return latin >= 8 && latin >= cjk * 3;
}
// 工具返回（［结果］后面那一大坨 JSON / 代码）什么时候算结束：碰到新的思考、新的调用，
// 或者一行"像人话"的中文（不缩进、不是括号引号开头、不带 "key": 这种）。
function looksLikeProse(line) {
  if (/^\s/.test(line) || /^[{}\[\]"'`<\d|-]/.test(line) || /"\s*:/.test(line)) return false;
  return (line.match(/[\u3400-\u9fff]/g) || []).length >= 2;
}

// 一句话拆成有序的几块：text 正文 / think 思考 / tool 调用了什么 / result 工具返回
function splitParts(body) {
  const parts = [];
  let cur = null;
  const push = (type, line) => {
    if (!cur || cur.type !== type) { cur = { type, content: line }; parts.push(cur); }
    else cur.content += '\n' + line;
  };
  let mode = 'text', thinkHasReasoning = false, thinkStartIdx = -1;
  // 思考块里一行英文都没有，说明这不是真的英文思考，退回正文、把"（思考）"标记也留着
  const closeThink = () => {
    if (mode === 'think' && !thinkHasReasoning && thinkStartIdx >= 0) parts[thinkStartIdx].type = 'text';
  };
  for (const line of body.split('\n')) {
    const tool = line.match(TOOL_LINE);
    if (tool) { closeThink(); mode = 'text'; cur = null; parts.push({ type: 'tool', content: tool[1].trim() }); continue; }
    const res = line.match(RESULT_LINE);
    if (res) { closeThink(); mode = 'result'; cur = null; push('result', res[1]); continue; }
    if (THINK_MARK.test(line)) {
      closeThink(); mode = 'think'; cur = null;
      const rest = line.replace(THINK_MARK, '');
      thinkHasReasoning = isReasoningLine(rest);
      push('think', thinkHasReasoning ? rest : line);
      thinkStartIdx = parts.length - 1;
      continue;
    }
    if (mode === 'think') {
      if (!line.trim() || isReasoningLine(line)) { if (line.trim()) thinkHasReasoning = true; push('think', line); continue; }
      closeThink(); mode = 'text';
    } else if (mode === 'result') {
      if (!looksLikeProse(line)) { push('result', line); continue; }
      mode = 'text';
    }
    push('text', line);
  }
  closeThink();
  return parts.map(p => ({ type: p.type, content: p.type === 'tool' ? p.content : p.content.replace(/^\n+|\s+$/g, '') }))
    .filter(p => p.content || p.type === 'result');
}

function timeOf(hhmm, stamp) {
  if (hhmm) return hhmm.padStart(5, '0');
  const m = stamp && stamp.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : '';
}

export function parseDialog(content) {
  const src = String(content || '');
  const heads = [];
  SPEAKER_RE.lastIndex = 0;
  let m;
  while ((m = SPEAKER_RE.exec(src)) !== null) {
    heads.push({ start: m.index, bodyStart: m.index + m[0].length, name: m[2], time: timeOf(m[1], m[3]) });
    if (m[0].length === 0) SPEAKER_RE.lastIndex++;
  }
  const messages = heads.map((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].start : src.length;
    return { speaker: speakerOf(h.name), name: h.name, time: h.time, start: h.start, body_start: h.bodyStart, end, parts: splitParts(src.slice(h.bodyStart, end)) };
  });
  const preamble = (heads.length ? src.slice(0, heads[0].start) : '').trim();
  return { preamble, preamble_end: heads.length ? heads[0].start : 0, messages };
}

// 正文部分（不含思考、工具）拼起来
export function textOf(msg) { return msg.parts.filter(p => p.type === 'text').map(p => p.content).join('\n'); }

// 偏移落在哪一句里（二分）。落在第一句之前 → -1（在开头那段说明里）。
export function messageAt(messages, offset) {
  let lo = 0, hi = messages.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid].start <= offset) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// 年轮不改原文，id + 长度当缓存键就够了
const cache = new Map();
export function parseRingCached(ring) {
  const key = ring.id + ':' + (ring.content || '').length;
  let hit = cache.get(key);
  if (!hit) {
    hit = parseDialog(ring.content);
    if (cache.size > 300) cache.clear();
    cache.set(key, hit);
  }
  return hit;
}

// "ci-hours 状态检查 8月13日 (3/15)" → 系列名 + 第几段。长对话导入时被切成好几条，翻的时候要按段号接回去。
export function partOf(title) {
  const m = String(title || '').match(/^(.*?)\s*[(（]\s*(\d+)\s*\/\s*(\d+)\s*[)）]\s*$/);
  return m ? { series: m[1].trim(), part: Number(m[2]), parts: Number(m[3]) } : null;
}
