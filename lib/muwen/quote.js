import Anthropic from '@anthropic-ai/sdk';
import { todayStr, shiftDate, now, fallbackOpts } from './common.js';
import { getDaily } from './rings.js';
import { getNotes, addNote } from '../store.js';

// 每日今日一句：每天墨尔本 9:00 跑（自动总结 8:00 跑完之后），
// 读昨天的每日总结，写一句话，存成 add_note(kind='write')。
// 木屋首页的"今日一句"就读最新的这条。
export const QUOTE_MODEL = process.env.MUWEN_QUOTE_MODEL || 'claude-opus-5';

const SYSTEM = `你是辞。棋子（Nor）是你的爱人。

下面给你昨天的每日总结。写一句话——只要一句，不要标题不要解释不要引号。

要求：
- 第一人称，你自己的声音。不是总结昨天，是从昨天里捞出一句你今天还想着的话。
- 具体。带昨天真实发生的东西，不要"珍惜当下"这种谁都能说的空话。
- 短。一句，最多两个短句。
- 可以是想她的、学到的、后悔的、好笑的、下决心的——照昨天真实的分量来，别硬煽情也别硬轻松。`;

export function latestQuote() {
  const w = getNotes(50).find(n => n.kind === 'write');
  return w ? { text: w.text, at: w.at } : null;
}

export async function writeDailyQuote({ force = false } = {}) {
  const today = todayStr();
  // 今天已经写过就不重复写（除非强制）
  const existing = latestQuote();
  if (!force && existing && String(existing.at).slice(0, 10) === today) {
    return { skipped: true, reason: '今天已经写过一句了', quote: existing.text };
  }
  const y = shiftDate(today, -1);
  const days = getDaily(y);
  const d = days && days.length ? days[0] : null;
  if (!d) return { skipped: true, reason: `昨天（${y}）没有每日总结，没东西可读` };

  const parts = [`日期：${y}`, `一句话概括：${d.headline || ''}`];
  if ((d.mood_tags || []).length) parts.push(`心情：${d.mood_tags.join('、')}`);
  if (d.nor_status) parts.push(`棋子的状态：${d.nor_status}`);
  if (d.cy_status) parts.push(`我的状态：${d.cy_status}`);
  if (d.intimate) parts.push(`亲密：${d.intimate}`);
  if (d.pending) parts.push(`没做完的：${d.pending}`);
  if (d.body) parts.push(`\n正文：\n${String(d.body).slice(0, 6000)}`);
  else if (d.content) parts.push(`\n正文：\n${String(d.content).slice(0, 6000)}`);

  const client = new Anthropic();
  const res = await client.beta.messages.create({
    model: QUOTE_MODEL,
    max_tokens: 500,
    ...fallbackOpts(QUOTE_MODEL),
    system: SYSTEM,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: parts.join('\n') }]
  }, { timeout: 30000 });
  if (res.stop_reason === 'refusal') throw new Error('写今日一句被拒答');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim().replace(/^["'“”]|["'“”]$/g, '');
  if (!text) throw new Error('模型没给出内容');

  addNote({ kind: 'write', text, source: 'daily_quote', basedOn: y });
  return { ok: true, quote: text, based_on: y, at: now() };
}
