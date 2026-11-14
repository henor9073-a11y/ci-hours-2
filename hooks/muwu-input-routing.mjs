// The channel is selected from structured message fields, never from its prose.
export function inputChannel(message) {
  if (message.sender === 'system' || message.voice_label?.skip === true) return 'muwu-system';
  return message.type === 'voice' ? 'muwu-voice' : 'muwu-chat';
}
export function channelMeta(message) {
  const channel = inputChannel(message), system = channel === 'muwu-system';
  return {
    origin: channel.replaceAll('-', '_'), speaker: system ? 'system' : message.sender,
    kind: message.type, msg_id: message.id, sent_at: message.at,
    source_device: message.source_device || '', source: message.source || message.type,
    counts_as_user_activity: String(!system && message.sender === 'nor'),
    reply_tool: system ? 'none' : 'chat_reply', requires_reply: String(!system),
  };
}
export function safeMeta(value) {
  return Object.fromEntries(Object.entries(value).filter(([k,v]) => /^[A-Za-z0-9_]+$/.test(k) && v != null).map(([k,v]) => [k,String(v)]));
}
export const instructions = {
  'muwu-chat': '木屋聊天独立入口。Nor 的文字、图片、表情包、引用在此，kind 保留原类型；图片用 chat_get_image(msg_id) 查看。按每条消息 text_for_cy 的 reply_mode 使用 chat_reply 或自动同步回复，禁止改用 StackChan 扬声器。通话中发送的聊天仍是聊天，不能误作麦克风输入。',
  'muwu-voice': '木屋语音留言独立入口。这里是 Nor 主动录制并发送的音频，不是实时电话。内容包含时长、自动转写与可选声音观察；转写可能有错，推测的情绪不等于她的原话，以她的纠正为准。回复遵守消息里的 reply_mode，不能用 stackchan_speak 或 call_say 代替。',
  'muwu-call': '实时通话独立入口。每句绑定 call_id、owner_session_id、event_id 和 input_sources；只能用 call_say 并传入原事件的 call_id 对这通电话口语回复，不再用 chat_reply 重复发送。通话属于发起/选定的窗口，禁止强行交给主窗口。普通内容不自动召回，明确询问过去才轻量召回。',
  'muwu-system': '系统事件独立入口。speaker=system，不是 Nor 在说话，也不应重置用户活跃计时或据此判断她的情绪。source/kind 区分通话状态、环境音、情绪更正、唤醒等。环境声音只是有不确定性的听觉观察，不推断她的位置或意图，不必逐条回复。来电 ringing 需要用 call_accept/call_reject 处理，通话属于 owner_session_id。',
};
