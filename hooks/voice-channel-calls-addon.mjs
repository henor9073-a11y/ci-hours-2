// 给 GPD 的 voice-channel.mjs 使用：在同一个 Claude Code channel/session 中轮询木屋通话。
// voice-channel.mjs 连接 mcp 后调用：
//   import { startCallBridge } from './voice-channel-calls-addon.mjs'
//   startCallBridge({ mcp, muwu: MUWU, safeMeta, log })
export function startCallBridge({ mcp, muwu, safeMeta, log = console.error }) {
  if (!muwu) return { stop() {} };
  const base = muwu.url.replace(/\/$/, '');
  const q = 'token=' + encodeURIComponent(muwu.token);
  const pushed = new Set(), utteranceBuffer = new Map(); let busy = false, bufferChangedAt = 0;
  async function poll() {
    if (busy) return; busy = true;
    try {
      const r = await fetch(`${base}/api/call/pending?${q}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('取通话事件 HTTP ' + r.status);
      const { call, events = [], settings = {} } = await r.json();
      const fresh = events.filter(x => !pushed.has(x.id) && !utteranceBuffer.has(x.id));
      for (const e of fresh.filter(x => x.type === 'utterance')) { utteranceBuffer.set(e.id, e); bufferChangedAt = Date.now(); }
      for (const e of fresh.filter(x => x.type !== 'utterance')) {
        const content = e.type === 'ringing'
          ? '棋子正在给你打电话。请立刻决定用 call_accept 接听，或者 call_reject 拒接；不要只在终端里回答。'
          : e.type === 'accepted' ? '电话已接通。进入通话轻量模式：请口语化简短回答；普通内容暂停自动 recall，明确问过去时才轻量召回。'
            : `电话状态：${e.type}`;
        await mcp.notification({ method: 'notifications/claude/channel', params: {
          content, meta: safeMeta({ origin: 'muwu_call', speaker: 'nor', call_id: call?.id || e.call_id, event_id: e.id, kind: e.type, sent_at: e.at })
        }});
        pushed.add(e.id);
      }
      const wait = settings.tokenMode === 'economy' ? 2000 : settings.tokenMode === 'low_latency' ? 0 : 700;
      if (utteranceBuffer.size && Date.now() - bufferChangedAt >= wait) {
        const batch = [...utteranceBuffer.values()];
        const content = batch.map(e => e.text).join('\n');
        await mcp.notification({ method: 'notifications/claude/channel', params: {
          content, meta: safeMeta({ origin: 'muwu_call', speaker: 'nor', call_id: call?.id || batch[0].call_id,
            event_id: batch.at(-1).id, event_ids: batch.map(e => e.id).join(','), kind: batch.length > 1 ? 'utterance_batch' : 'utterance', sent_at: batch.at(-1).at })
        }});
        batch.forEach(e => { pushed.add(e.id); utteranceBuffer.delete(e.id); });
      }
      if (pushed.size) {
        const ids = [...pushed];
        const d = await fetch(`${base}/api/call/delivered?${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }), signal: AbortSignal.timeout(15000) });
        if (!d.ok) throw new Error('回报通话事件 HTTP ' + d.status);
        ids.forEach(id => pushed.delete(id));
      }
    } catch (e) { log('木屋通话轮询失败', e?.message); }
    finally { busy = false; }
  }
  const timer = setInterval(() => poll().catch(e => log('通话轮询异常', e?.message)), 1000);
  poll(); log('木屋通话：已接上，每 1 秒取一次');
  return { stop() { clearInterval(timer); } };
}
