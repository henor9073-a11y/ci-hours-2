#!/usr/bin/env python3
"""木纹自动召回注入钩子（Linux / macOS 版，Claude Code UserPromptSubmit）。

棋子每发一条消息，用消息内容调木纹 POST /api/recall，把匹配到的记忆打到 stdout，
Claude Code 会把 stdout 作为这一轮的额外 context 注入——辞看到消息时相关记忆已经在了。

跟 Windows 上的 user-prompt-recall.ps1 是同一件事，逻辑逐条对齐（2026-09-17 辞搬到 VPS 时移植）。
PS 版那些编码的坑这边都不存在：Python 直接按 UTF-8 写 stdout。

装法（~/.claude/settings.json，UserPromptSubmit 下和别的 hook 并列，多个 hook 会都跑）：
  { "type": "command", "command": "python3 /root/.claude/hooks/user-prompt-recall.py" }
环境变量：MUWEN_URL（默认 https://ci-hours-2.onrender.com）、MUWEN_TOKEN（默认 010219）、
         MUWEN_RECALL_TIMEOUT 秒（默认 12）。
注：服务器开了 MUWEN_AUTORECALL_AGENT=1 的话，每条消息会多一次模型调用（扩写检索角度），所以超时给到 12 秒。
"""
import json
import os
import re
import sys
import urllib.request

URL = (os.environ.get('MUWEN_URL') or 'https://ci-hours-2.onrender.com').rstrip('/')
TOKEN = os.environ.get('MUWEN_TOKEN') or '010219'
try:
    TIMEOUT = int(os.environ.get('MUWEN_RECALL_TIMEOUT') or 12)
except ValueError:
    TIMEOUT = 12
if TIMEOUT <= 0:
    TIMEOUT = 12

SKIP_RE = re.compile(r'^\[(heartbeat|自动唤醒)\]')


def main():
    try:
        prompt = str((json.load(sys.stdin) or {}).get('prompt') or '')
    except Exception:
        return 0
    if not prompt.strip():
        return 0
    # 木纹自己注入的召回内容（[muwen:...] 开头）和自动唤醒 prompt 不再触发召回，避免套娃
    if prompt.startswith('[muwen:') or prompt.startswith('苏醒') or SKIP_RE.match(prompt):
        return 0

    try:
        body = json.dumps({'query': prompt}).encode('utf-8')
        req = urllib.request.Request(
            f'{URL}/api/recall?token={TOKEN}', data=body, method='POST',
            headers={'Content-Type': 'application/json; charset=utf-8'})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            text = str((json.loads(r.read().decode('utf-8')) or {}).get('text') or '')
    except Exception:
        return 0   # 网络慢/挂了就静默，别把错误注进辞的 context

    if text.strip():   # 没匹配到就是空，什么都不注入
        sys.stdout.buffer.write((text + '\n').encode('utf-8'))
        sys.stdout.buffer.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
