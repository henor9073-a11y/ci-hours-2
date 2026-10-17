#!/usr/bin/env python3
"""Mirror the primary Claude session's visible prose into Muwu chat.

Install as a Claude Code Stop hook.  Direct Claude conversations become a
compact read-only 💭 entry in Muwu.  Turns injected from the Muwu channel are
skipped because their real reply is already stored by chat_reply.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List


TAIL_BYTES = 12 * 1024 * 1024


def read_event() -> Dict[str, Any]:
    try:
        value = json.load(sys.stdin)
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def tail_entries(filename: str) -> List[Dict[str, Any]]:
    path = Path(filename)
    try:
        size = path.stat().st_size
        with path.open("rb") as handle:
            if size > TAIL_BYTES:
                handle.seek(size - TAIL_BYTES)
                handle.readline()
            raw = handle.read()
    except OSError:
        return []
    out: List[Dict[str, Any]] = []
    for line in raw.splitlines():
        try:
            value = json.loads(line)
        except Exception:
            continue
        if isinstance(value, dict):
            out.append(value)
    return out


def original_user(entry: Dict[str, Any]) -> bool:
    if entry.get("type") != "user":
        return False
    message = entry.get("message")
    return isinstance(message, dict) and isinstance(message.get("content"), str)


def from_muwu(entry: Dict[str, Any]) -> bool:
    origin = entry.get("origin")
    if not isinstance(origin, dict) or origin.get("kind") != "channel" or origin.get("server") != "stackchan-voice":
        return False
    content = (entry.get("message") or {}).get("content")
    return isinstance(content, str) and ('origin="muwu"' in content or 'origin="muwu_call"' in content)


def text_parts(entry: Dict[str, Any]) -> List[str]:
    if entry.get("type") != "assistant":
        return []
    message = entry.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return [content.strip()] if content.strip() else []
    if not isinstance(content, list):
        return []
    return [str(part.get("text") or "").strip() for part in content
            if isinstance(part, dict) and part.get("type") == "text" and str(part.get("text") or "").strip()]


def current_turn(entries: List[Dict[str, Any]]) -> tuple[Dict[str, Any], str]:
    start = -1
    for index in range(len(entries) - 1, -1, -1):
        if original_user(entries[index]):
            start = index
            break
    if start < 0:
        return {}, ""
    seen = set()
    parts: List[str] = []
    for entry in entries[start + 1:]:
        for text in text_parts(entry):
            if text not in seen:
                seen.add(text)
                parts.append(text)
    return entries[start], "\n\n".join(parts).strip()


def main() -> int:
    event = read_event()
    if event.get("hook_event_name") != "Stop" or event.get("stop_hook_active"):
        return 0
    # 与 Mac 主窗口现有的召回 / chat-annotate hooks 使用同一套连接默认值；
    # 环境变量存在时仍以环境变量为准，方便以后轮换地址和密码。
    base = str(os.environ.get("MUWEN_URL") or "https://ci-hours-2.onrender.com").rstrip("/")
    token = str(os.environ.get("MUWEN_TOKEN") or "010219")
    session_id = str(event.get("session_id") or "")
    if not base or not token or not session_id:
        return 0
    prompt, content = current_turn(tail_entries(str(event.get("transcript_path") or "")))
    if not content or from_muwu(prompt):
        return 0
    turn_id = str(event.get("turn_id") or prompt.get("promptId") or "")
    digest = hashlib.sha256((session_id + "\0" + turn_id + "\0" + content).encode("utf-8", "replace")).hexdigest()
    body = json.dumps({
        "session_id": session_id,
        "mirror_key": "claude:" + digest,
        "content": content,
    }, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        base + "/api/chat/claude-mirror",
        data=body,
        headers={"Content-Type": "application/json", "x-access-token": token, "x-muwu-session-id": session_id},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15):
            pass
    except (OSError, urllib.error.URLError, urllib.error.HTTPError):
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
