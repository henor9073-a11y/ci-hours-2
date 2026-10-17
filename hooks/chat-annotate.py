#!/usr/bin/env python3
"""木屋聊天：把辞这一轮真实的思考过程和工具调用补到 chat_reply 发出去的那条消息上（Claude Code PostToolUse 钩子）。

棋子要的是"直接用他原本的 thinking，不是让他自己重写一个"。模型自己看不到自己的 thinking 块，
但会话记录（transcript jsonl）里有。所以在他调完 chat_reply 之后，这个钩子：
  1. 从 stdin 拿 tool_response 里那条消息的 id
  2. 从 transcript 末尾往回读到这一轮开始（上一条真正的 user 消息），收集所有 thinking 块和 tool_use 名字
  3. POST /api/chat/annotate 覆盖上去——棋子那边显示成「Thought process ›」「Used N tools ›」，跟 Claude 官方 App 一样

装法（settings.json → hooks.PostToolUse，matcher 写 chat_reply 那个工具名）：
  { "matcher": "mcp__muwen__chat_reply", "hooks": [{ "type": "command", "command": "python \"C:\\Users\\<你>\\.claude\\hooks\\chat-annotate.py\"", "timeout": 20 }] }
环境变量：MUWEN_URL（默认 https://ci-hours-2.onrender.com）、MUWEN_TOKEN（默认 010219）。
出任何错都静默退出——这是锦上添花，不能影响他回消息。不记日志：thinking 是他的心里话。
"""
import json
import os
import sys
import urllib.request

URL = (os.environ.get('MUWEN_URL') or 'https://ci-hours-2.onrender.com').rstrip('/')
TOKEN = os.environ.get('MUWEN_TOKEN') or '010219'
TAIL_BYTES = 6 * 1024 * 1024      # 一轮对话不会超过这么多；transcript 动辄上百 MB，别整个读
SELF = 'chat_reply'
SENSITIVE_KEYS = ('token', 'password', 'secret', 'authorization', 'api_key', 'apikey', 'cookie')


def clipped(value, limit):
    text = str(value or '').strip()
    if len(text) <= limit:
        return text
    return text[:limit] + '\n…（详情过长，已截断）'


def safe_value(value):
    """保留操作细节，但不把凭据跟着聊天记录带到手机。"""
    if isinstance(value, dict):
        return {
            str(key): ('[已隐藏]' if any(mark in str(key).lower() for mark in SENSITIVE_KEYS) else safe_value(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [safe_value(item) for item in value]
    return value


def input_text(value):
    if value in (None, {}, []):
        return ''
    try:
        return clipped(json.dumps(safe_value(value), ensure_ascii=False, indent=2), 3000)
    except Exception:
        return clipped(value, 3000)


def result_text(value):
    if isinstance(value, str):
        return clipped(value, 6000)
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict) and item.get('type') == 'text':
                parts.append(str(item.get('text') or ''))
            elif isinstance(item, str):
                parts.append(item)
        return clipped('\n'.join(part for part in parts if part), 6000)
    if isinstance(value, dict):
        try:
            return clipped(json.dumps(safe_value(value), ensure_ascii=False, indent=2), 6000)
        except Exception:
            pass
    return clipped(value, 6000)


def message_id(tool_response):
    """tool_response 可能是 dict（content 数组）、字符串、或者已经解好的对象。"""
    texts = []
    if isinstance(tool_response, dict):
        if 'id' in tool_response:
            return tool_response['id']
        for c in tool_response.get('content') or []:
            if isinstance(c, dict) and c.get('type') == 'text':
                texts.append(c.get('text') or '')
    elif isinstance(tool_response, str):
        texts.append(tool_response)
    elif isinstance(tool_response, list):
        for c in tool_response:
            if isinstance(c, dict) and c.get('type') == 'text':
                texts.append(c.get('text') or '')
    for t in texts:
        try:
            j = json.loads(t)
            if isinstance(j, dict) and j.get('id') and j.get('sender') == 'cy':
                return j['id']
        except Exception:
            continue
    return None


def read_tail_lines(path):
    with open(path, 'rb') as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - TAIL_BYTES))
        data = f.read()
    lines = data.split(b'\n')
    if size > TAIL_BYTES:
        lines = lines[1:]          # 第一行是半截
    out = []
    for l in lines:
        if not l.strip():
            continue
        try:
            out.append(json.loads(l.decode('utf-8', 'replace')))
        except Exception:
            continue
    return out


def this_turn(entries, tool_use_id):
    """从后往前：先找到这次 chat_reply 的 tool_use 所在的 assistant 条目，再往前收到上一条真正的 user 消息为止。"""
    end = None
    for i in range(len(entries) - 1, -1, -1):
        e = entries[i]
        if e.get('type') != 'assistant':
            continue
        for c in (e.get('message') or {}).get('content') or []:
            if isinstance(c, dict) and c.get('type') == 'tool_use' and (tool_use_id is None or c.get('id') == tool_use_id) and str(c.get('name', '')).endswith(SELF):
                end = i
                break
        if end is not None:
            break
    if end is None:
        return [], []
    start = -1
    for i in range(end - 1, -1, -1):
        e = entries[i]
        msg = e.get('message') or {}
        content = msg.get('content')
        if e.get('type') == 'user':
            # tool_result 也是 type=user；真正的人说话是 content 为字符串或者带 text 块
            if isinstance(content, str) or any(isinstance(c, dict) and c.get('type') == 'text' for c in (content or [])):
                start = i
                break
    thinking, tools, by_id = [], [], {}
    for e in entries[start + 1:end + 1]:
        content = (e.get('message') or {}).get('content') or []
        if not isinstance(content, list):
            continue
        for c in content:
            if not isinstance(c, dict):
                continue
            if e.get('type') == 'assistant' and c.get('type') == 'thinking' and c.get('thinking'):
                thinking.append(c['thinking'])
            elif e.get('type') == 'assistant' and c.get('type') == 'tool_use':
                name = str(c.get('name') or '')
                if name and not name.endswith(SELF):
                    tool = {'name': name}
                    request = input_text(c.get('input'))
                    if request:
                        tool['input'] = request
                    tools.append(tool)
                    if c.get('id'):
                        by_id[str(c['id'])] = tool
            elif e.get('type') == 'user' and c.get('type') == 'tool_result':
                tool = by_id.get(str(c.get('tool_use_id') or ''))
                if tool is not None:
                    result = result_text(c.get('content'))
                    if result:
                        tool['result'] = result
    return thinking, tools


def main():
    try:
        payload = json.load(sys.stdin) or {}
    except Exception:
        return 0
    if not str(payload.get('tool_name', '')).endswith(SELF):
        return 0
    mid = message_id(payload.get('tool_response'))
    path = payload.get('transcript_path')
    if not mid or not path or not os.path.exists(path):
        return 0
    try:
        entries = read_tail_lines(path)
        thinking, tools = this_turn(entries, payload.get('tool_use_id'))
    except Exception:
        return 0
    if not thinking and not tools:
        return 0
    body = {'id': mid, 'tools': tools}
    if thinking:
        body['thinking'] = '\n\n'.join(t.strip() for t in thinking if t.strip())
    try:
        req = urllib.request.Request(
            f'{URL}/api/chat/annotate?token={TOKEN}', data=json.dumps(body).encode('utf-8'), method='POST',
            headers={'Content-Type': 'application/json; charset=utf-8'})
        urllib.request.urlopen(req, timeout=15).read()
    except Exception:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
