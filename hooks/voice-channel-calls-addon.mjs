// 给 GPD 的 voice-channel.mjs 使用：在同一个 Claude Code channel/session 中轮询木屋通话。
// voice-channel.mjs 连接 mcp 后调用：
//   import { startCallBridge } from './voice-channel-calls-addon.mjs'
//   startCallBridge({ mcp, muwu: MUWU, safeMeta, log })
export function startCallBridge({ mcp, muwu, safeMeta, log = console.error }) {
  if (!muwu) return { stop() {} };
  const base = muwu.url.replace(/\/$/, '');
  const q = 'token=' + encodeURIComponent(muwu.token);
  const pushed = new Set(); let busy = false;
  async function poll() {
    if (busy) return; busy = true;
    try {
      const r = await fetch(`${base}/api/call/pending?${q}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('取通话事件 HTTP ' + r.status);
      const { call, events = [] } = await r.json();
      for (const e of events.filter(x => !pushed.has(x.id))) {
        const content = e.type === 'ringing'
          ? '棋子正在给你打电话。请立刻决定用 call_accept 接听，或者 call_reject 拒接；不要只在终端里回答。'
          : e.type === 'utterance' ? e.text
            : `电话状态：${e.type}`;
        await mcp.notification({ method: 'notifications/claude/channel', params: {
          content, meta: safeMeta({ origin: 'muwu_call', speaker: 'nor', call_id: call?.id || e.call_id, event_id: e.id, kind: e.type, sent_at: e.at })
        }});
        pushed.add(e.id);
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
