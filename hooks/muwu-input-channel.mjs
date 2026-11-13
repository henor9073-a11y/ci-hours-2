#!/usr/bin/env node
// Start separately as muwu-chat, muwu-voice, muwu-call and muwu-system.
// Uses the same MCP SDK installation as the existing parallel-recall-mcp runner.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs';
import { inputChannel, channelMeta, safeMeta, instructions } from './muwu-input-routing.mjs';
import { startCallBridge } from './voice-channel-calls-addon.mjs';
const name = process.env.MUWU_CHANNEL;
if (!Object.hasOwn(instructions, name)) throw new Error('MUWU_CHANNEL 必须是 muwu-chat / muwu-voice / muwu-call / muwu-system');
let stored = {};
try { stored = JSON.parse(fs.readFileSync(new URL('./.muwu.json', import.meta.url), 'utf8')); }
catch { /* Environment variables remain the explicit fallback. */ }
const url = String(process.env.MUWU_URL || stored.url || '').replace(/\/$/, '');
const token = process.env.MUWU_TOKEN || stored.token || '';
const sessionId = process.env.MUWU_SESSION_ID || '';
if (!url || !token || !sessionId) throw new Error('缺少木屋地址、令牌或窗口身份');
const mcp = new Server({ name, version: '2.0.0' }, {
  capabilities: { experimental: { 'claude/channel': {} } }, instructions: instructions[name],
});
await mcp.connect(new StdioServerTransport());
const q = new URLSearchParams({ token, session_id: sessionId });
const pendingAck = new Set();
let busy = false;
async function poll() {
  if (busy) return; busy = true;
  try {
    const response = await fetch(`${url}/api/chat/pending?${q}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`取消息 HTTP ${response.status}`);
    const { messages = [] } = await response.json();
    for (const message of messages.filter(m => inputChannel(m) === name && !pendingAck.has(m.id))) {
      await mcp.notification({ method: 'notifications/claude/channel', params: {
        content: message.text_for_cy, meta: safeMeta(channelMeta(message)),
      }});
      pendingAck.add(message.id);
    }
    if (pendingAck.size) {
      const ids = [...pendingAck];
      const ack = await fetch(`${url}/api/chat/delivered?${q}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }), signal: AbortSignal.timeout(15000),
      });
      if (!ack.ok) throw new Error(`确认送达 HTTP ${ack.status}`);
      ids.forEach(id => pendingAck.delete(id));
    }
  } catch (error) { console.error(`[${name}]`, error.message); }
  finally { busy = false; }
}
const handles = [];
if (name !== 'muwu-call') { handles.push(setInterval(poll, 1000)); poll(); }
const calls = ['muwu-call','muwu-system'].includes(name) ? startCallBridge({
  mcp, muwu: { url, token, sessionId }, safeMeta, nursery: false,
  eventTypes: e => name === 'muwu-call' ? e.type === 'utterance' : e.type !== 'utterance',
}) : null;
function stop() { handles.forEach(clearInterval); calls?.stop(); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
