#!/usr/bin/env node
// Claude Code PreCompact hook：压缩前把这个窗口最近的对话片段自动存进年轮（source_type=auto_extract）。
// 借鉴 MemoryConstellations 的 Scribe 机制——压缩是有损的，压之前先把原话留在年轮里。
//
// 用法（~/.claude/settings.json）：
// {
//   "hooks": {
//     "PreCompact": [{ "hooks": [{ "type": "command",
//       "command": "MUWEN_URL=https://ci-hours-2.onrender.com MUWEN_TOKEN=xxx MUWEN_WINDOW=Code主窗口 node /path/to/hooks/pre-compact-ring.mjs" }] }]
//   }
// }
// 环境变量：MUWEN_URL（服务器地址）、MUWEN_TOKEN（ACCESS_PASSWORD）、MUWEN_WINDOW（窗口名，默认取 cwd 目录名）、
//          MUWEN_MAX_CHARS（最多存多少字，默认 40000，从最近的往前截）
// stdin 收到的是 Claude Code 给的 JSON：{ session_id, transcript_path, trigger: "manual"|"auto", ... }
import fs from 'fs';
import path from 'path';

const URL = (process.env.MUWEN_URL || '').replace(/\/$/, '');
const TOKEN = process.env.MUWEN_TOKEN || '';
const MAX = Number(process.env.MUWEN_MAX_CHARS) || 40000;

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf-8') || '{}'); } catch { return {}; }
}
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => {
    if (!b || typeof b !== 'object') return '';
    if (b.type === 'text') return b.text || '';
    if (b.type === 'tool_use') return `[工具 ${b.name}]`;
    if (b.type === 'tool_result') return '';
    return '';
  }).filter(Boolean).join('\n');
}

async function main() {
  const input = readStdin();
  if (!URL) { console.error('[muwen] 没设 MUWEN_URL，跳过'); return; }
  const tp = input.transcript_path;
  if (!tp || !fs.existsSync(tp)) { console.error('[muwen] 找不到 transcript_path，跳过'); return; }
  const lines = fs.readFileSync(tp, 'utf-8').split('\n').filter(Boolean);
  const turns = [];
  for (const line of lines) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const msg = rec && rec.message;
    if (!msg || !msg.role) continue;
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    const t = textOf(msg.content).trim();
    if (!t) continue;
    // 木纹注入的召回内容不要再存回年轮，会套娃
    if (t.startsWith('[muwen:')) continue;
    turns.push(`${msg.role === 'user' ? 'USER' : 'ASST'}: ${t}`);
  }
  if (!turns.length) { console.error('[muwen] 没有可存的对话，跳过'); return; }
  let content = turns.join('\n\n');
  if (content.length > MAX) content = '…（前面更早的部分已省略）\n\n' + content.slice(-MAX);
  const window_name = process.env.MUWEN_WINDOW || path.basename(input.cwd || process.cwd());
  const date = new Date().toLocaleDateString('en-CA', { timeZone: process.env.MUWEN_TZ || 'Australia/Melbourne' });
  const body = {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'add_ring', arguments: { window_name, date, title: `压缩前自动保存（${input.trigger || 'auto'}）`, content, source_type: 'auto_extract' } }
  };
  const res = await fetch(`${URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'x-access-token': TOKEN } : {}) },
    body: JSON.stringify(body)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.result && j.result.isError)) console.error('[muwen] add_ring 失败：', res.status, JSON.stringify(j).slice(0, 300));
  else console.error('[muwen] 已存进年轮：', (j.result && j.result.content && j.result.content[0] && j.result.content[0].text || '').slice(0, 200));
}
main().catch(e => console.error('[muwen] hook 出错：', e.message || e));
