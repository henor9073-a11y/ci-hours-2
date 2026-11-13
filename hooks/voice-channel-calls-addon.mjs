// 给 GPD 的 voice-channel.mjs 使用：在同一个 Claude Code channel/session 中轮询木屋通话和婴儿房。
// voice-channel.mjs 连接 mcp 后调用：
//   import { startCallBridge } from './voice-channel-calls-addon.mjs'
//   startCallBridge({ mcp, muwu: MUWU, safeMeta, log })
export function startCallBridge({ mcp, muwu, safeMeta, log = console.error, nursery = true, eventTypes = null }) {
  if (!muwu?.sessionId) {
    if (muwu) log('木屋通话：缺少 MUWU_SESSION_ID，为避免多个窗口同时接听，保持关闭');
    return { stop() {} };
  }
  const base = muwu.url.replace(/\/$/, '');
  const q = 'token=' + encodeURIComponent(muwu.token) + '&session_id=' + encodeURIComponent(muwu.sessionId);
  const pushed = new Set(), utteranceBuffer = new Map(); let busy = false, bufferChangedAt = 0;
  const nurseryPushed = new Set(); let nurseryBusy = false;
  let bufferedCallId = '';
  function utteranceText(e) {
    if (e.voice_label?.skip) return e.text;
    if (e.voice_label) {
      const tags = Array.isArray(e.voice_label.tags) ? e.voice_label.tags.filter(Boolean).join('、') : '';
      const note = String(e.voice_label.note || '').trim();
      const parts = [tags ? `她本人纠正的感受：${tags}` : '她本人纠正为没有明显情绪'];
      if (note) parts.push(`她的补充：${note}`);
      return `${e.text}\n[${parts.join('；')}；人工更正优先于机器推测]`;
    }
    const tone = e.voice_tone;
    if (!tone || !['ready', 'neutral'].includes(e.analysis_status)) return e.text;
    const parts = [];
    if (tone.tone) parts.push(String(tone.tone).slice(0, 120));
    if (e.analysis_status === 'ready' && Number(tone.confidence) >= 0.6 && tone.emotion) {
      parts.push(`可能的情绪：${String(tone.emotion).slice(0, 60)}`);
    }
    return parts.length ? `${e.text}\n[同一句的声音观察：${parts.join('；')}；不确定时以 Nor 更正为准]` : e.text;
  }
  async function poll() {
    if (busy) return; busy = true;
    try {
      const r = await fetch(`${base}/api/call/pending?${q}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('取通话事件 HTTP ' + r.status);
      const { call, events = [], settings = {} } = await r.json();
      if (call?.id !== bufferedCallId) {
        utteranceBuffer.clear(); pushed.clear(); bufferedCallId = call?.id || '';
      }
      const fresh = events.filter(x => (!eventTypes || eventTypes(x)) && !pushed.has(x.id) && !utteranceBuffer.has(x.id));
      for (const e of fresh.filter(x => x.type === 'utterance')) { utteranceBuffer.set(e.id, e); bufferChangedAt = Date.now(); }
      for (const e of fresh.filter(x => x.type !== 'utterance')) {
        // Older servers may still have queued one of these.  A voice analysis
        // update is metadata on its utterance, never a second conversational turn.
        if (e.type === 'voice_observation') { pushed.add(e.id); continue; }
        const content = e.type === 'ringing'
          ? '棋子正在给你打电话。请立刻决定用 call_accept 接听，或者 call_reject 拒接；不要只在终端里回答。'
          : e.type === 'accepted' ? '电话已接通。进入通话轻量模式：请口语化简短回答；普通内容暂停自动 recall，明确问过去时才轻量召回。'
            : ['ambient', 'emotion_correction'].includes(e.type) ? `[通话观察，非 Nor 原话] ${e.text}` : `电话状态：${e.type}`;
        await mcp.notification({ method: 'notifications/claude/channel', params: {
          content, meta: safeMeta({ origin: 'muwu_system', speaker: 'system', source: e.source || 'call_state',
            call_id: e.call_id, owner_session_id: call?.owner_session_id, event_id: e.id, kind: e.type,
            counts_as_user_activity: false, requires_reply: e.type === 'ringing', sent_at: e.at })
        }});
        pushed.add(e.id);
      }
      // 通话本身已经由 VAD 判断完句；这里只留很短的合并窗，避免又额外排队一整秒。
      const wait = settings.tokenMode === 'economy' ? 1400 : 0;
      if (utteranceBuffer.size && Date.now() - bufferChangedAt >= wait) {
        const batch = [...utteranceBuffer.values()];
        const content = batch.map(utteranceText).join('\n');
        await mcp.notification({ method: 'notifications/claude/channel', params: {
          content, meta: safeMeta({ origin: 'muwu_call', speaker: 'nor', call_id: batch[0].call_id,
            owner_session_id: call?.owner_session_id, reply_tool: 'call_say', counts_as_user_activity: true,
            event_id: batch.at(-1).id, event_ids: batch.map(e => e.id).join(','),
            input_sources: batch.map(e => e.source || 'voice').join(','),
            kind: batch.length > 1 ? 'utterance_batch' : 'utterance', sent_at: batch.at(-1).at })
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

  async function pollNursery() {
    if (nurseryBusy) return; nurseryBusy = true;
    try {
      const r = await fetch(`${base}/api/nursery/pending?${q}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('取婴儿房消息 HTTP ' + r.status);
      const { messages = [] } = await r.json();
      for (const message of messages) {
        if (nurseryPushed.has(message.id)) continue;
        await mcp.notification({ method: 'notifications/claude/channel', params: {
          content: message.text_for_cy || message.content,
          meta: safeMeta({
            origin: 'muwu_nursery',
            speaker: message.sender === 'kuri' ? 'kuri' : message.sender,
            room: message.room,
            message_id: message.id,
            source_device: message.source_device || '',
            sent_at: message.at
          })
        }});
        nurseryPushed.add(message.id);
      }
      if (nurseryPushed.size) {
        const ids = [...nurseryPushed];
        const d = await fetch(`${base}/api/nursery/delivered?${q}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids }), signal: AbortSignal.timeout(15000)
        });
        if (!d.ok) throw new Error('回报婴儿房消息 HTTP ' + d.status);
        ids.forEach(id => nurseryPushed.delete(id));
      }
    } catch (e) { log('婴儿房轮询失败', e?.message); }
    finally { nurseryBusy = false; }
  }

  const timer = setInterval(() => poll().catch(e => log('通话轮询异常', e?.message)), 400);
  const nurseryTimer = nursery
    ? setInterval(() => pollNursery().catch(e => log('婴儿房轮询异常', e?.message)), 1000)
    : null;
  poll(); if (nursery) pollNursery();
  log(`木屋通话${nursery ? '+婴儿房' : ''}：已绑定窗口 ${muwu.sessionId.slice(0, 8)}`);
  return { stop() { clearInterval(timer); if (nurseryTimer) clearInterval(nurseryTimer); } };
}
