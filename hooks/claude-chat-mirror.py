#!/usr/bin/env python3
"""Finalize one Claude turn into Muwu chat.

Default mode preserves the old behavior: direct Claude conversations become a
compact read-only 💭 entry and Muwu-origin turns are ignored. When the shared
``auto_sync_reply`` switch is enabled, the server promotes the same payload to
a normal Muwu bubble. The hook sends the turn once: visible prose, real
thinking, tool inputs/results and the originating Muwu message id travel in one
request and are deduplicated by ``mirror_key``.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Tuple


TAIL_BYTES = 12 * 1024 * 1024
SELF = "chat_reply"
SENSITIVE_KEYS = ("token", "password", "secret", "authorization", "api_key", "apikey", "cookie")


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


def reply_to(entry: Dict[str, Any]) -> str:
    if not from_muwu(entry):
        return ""
    content = str((entry.get("message") or {}).get("content") or "")
    match = re.search(r'\bmsg_id="([^"]+)"', content)
    return (match.group(1) if match else "")[:120]


def clipped(value: Any, limit: int) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit] + "\n…（详情过长，已截断）"


def safe_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): ("[已隐藏]" if any(mark in str(key).lower() for mark in SENSITIVE_KEYS) else safe_value(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [safe_value(item) for item in value]
    return value


def input_text(value: Any) -> str:
    if value in (None, {}, []):
        return ""
    try:
        return clipped(json.dumps(safe_value(value), ensure_ascii=False, indent=2), 3000)
    except Exception:
        return clipped(value, 3000)


def result_text(value: Any) -> str:
    if isinstance(value, str):
        return clipped(value, 6000)
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text") or ""))
            elif isinstance(item, str):
                parts.append(item)
        return clipped("\n".join(part for part in parts if part), 6000)
    if isinstance(value, dict):
        try:
            return clipped(json.dumps(safe_value(value), ensure_ascii=False, indent=2), 6000)
        except Exception:
            pass
    return clipped(value, 6000)


def current_turn(entries: List[Dict[str, Any]]) -> Tuple[Dict[str, Any], str, str, List[Dict[str, str]], bool]:
    start = -1
    for index in range(len(entries) - 1, -1, -1):
        if original_user(entries[index]):
            start = index
            break
    if start < 0:
        return {}, "", "", [], False

    seen_text = set()
    prose: List[str] = []
    thinking: List[str] = []
    tools: List[Dict[str, str]] = []
    by_id: Dict[str, Dict[str, str]] = {}
    has_chat_reply = False

    for entry in entries[start + 1:]:
        content = (entry.get("message") or {}).get("content") or []
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            kind = part.get("type")
            if entry.get("type") == "assistant" and kind == "text":
                text = str(part.get("text") or "").strip()
                if text and text not in seen_text:
                    seen_text.add(text)
                    prose.append(text)
            elif entry.get("type") == "assistant" and kind == "thinking" and part.get("thinking"):
                thinking.append(str(part["thinking"]))
            elif entry.get("type") == "assistant" and kind == "tool_use":
                name = str(part.get("name") or "")
                if name.endswith(SELF):
                    has_chat_reply = True
                    continue
                if name:
                    tool: Dict[str, str] = {"name": name}
                    request = input_text(part.get("input"))
                    if request:
                        tool["input"] = request
                    tools.append(tool)
                    if part.get("id"):
                        by_id[str(part["id"])] = tool
            elif entry.get("type") == "user" and kind == "tool_result":
                tool = by_id.get(str(part.get("tool_use_id") or ""))
                if tool is not None:
                    result = result_text(part.get("content"))
                    if result:
                        tool["result"] = result

    return (
        entries[start],
        "\n\n".join(prose).strip(),
        "\n\n".join(item.strip() for item in thinking if item.strip()),
        tools[:40],
        has_chat_reply,
    )


def main() -> int:
    event = read_event()
    if event.get("hook_event_name") != "Stop" or event.get("stop_hook_active"):
        return 0
    base = str(os.environ.get("MUWEN_URL") or "https://ci-hours-2.onrender.com").rstrip("/")
    token = str(os.environ.get("MUWEN_TOKEN") or "010219")
    session_id = str(event.get("session_id") or "")
    if not base or not token or not session_id:
        return 0

    prompt, content, thinking, tools, has_chat_reply = current_turn(
        tail_entries(str(event.get("transcript_path") or ""))
    )
    if not content:
        return 0
    turn_id = str(event.get("turn_id") or prompt.get("promptId") or "")
    digest = hashlib.sha256((session_id + "\0" + turn_id + "\0" + content).encode("utf-8", "replace")).hexdigest()
    body = json.dumps({
        "session_id": session_id,
        "mirror_key": "claude:" + digest,
        "content": content,
        "thinking": thinking,
        "tools": tools,
        "from_muwu": from_muwu(prompt),
        "reply_to": reply_to(prompt),
        "has_chat_reply": has_chat_reply,
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
