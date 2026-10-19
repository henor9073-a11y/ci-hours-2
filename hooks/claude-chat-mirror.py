#!/usr/bin/env python3
"""Finalize one Claude turn into Muwu chat.

Default mode preserves the old behavior: direct Claude conversations become a
compact read-only 💭 entry and Muwu-origin turns are ignored. When the shared
``auto_sync_reply`` switch is enabled, the server promotes the same payload to
a normal Muwu bubble. The hook sends visible prose, real thinking and tool
inputs/results once; the server deduplicates the turn by ``mirror_key``.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from datetime import datetime
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List


TAIL_BYTES = 12 * 1024 * 1024
SELF = "chat_reply"
SENSITIVE_KEYS = ("token", "password", "secret", "authorization", "api_key", "apikey", "cookie")
LOG_PATH = Path(os.environ.get("MUWEN_MIRROR_LOG") or Path.home() / ".claude" / "hooks" / "claude-chat-mirror.log")


def log_status(status: str, **fields: Any) -> None:
    """Keep a compact diagnostic trail without storing conversation text."""
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        payload = {"at": datetime.now().isoformat(timespec="seconds"), "status": status, **fields}
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    except OSError:
        pass


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


def message_text(entry: Dict[str, Any]) -> str:
    message = entry.get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            str(part.get("text") or "")
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    return ""


def original_user(entry: Dict[str, Any]) -> bool:
    if entry.get("type") != "user":
        return False
    if entry.get("isMeta") is True or entry.get("is_meta") is True:
        return False
    message = entry.get("message")
    if not isinstance(message, dict) or not isinstance(message.get("content"), str):
        return False
    text = str(message.get("content") or "").lstrip()
    return not text.startswith("Stop hook feedback:")


def from_muwu(entry: Dict[str, Any]) -> bool:
    origin = entry.get("origin")
    if not isinstance(origin, dict) or origin.get("kind") != "channel" or origin.get("server") != "stackchan-voice":
        return False
    content = (entry.get("message") or {}).get("content")
    return isinstance(content, str) and ('origin="muwu"' in content or 'origin="muwu_call"' in content)


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


def stop_feedback(entry: Dict[str, Any]) -> str:
    text = message_text(entry).strip()
    if text.startswith("Stop hook feedback:"):
        return text
    if entry.get("type") == "system" and str(entry.get("subtype") or "") == "stop_hook_summary":
        return text or str(entry.get("hookInfos") or "")
    return ""


def feedback_rules(text: str) -> List[Dict[str, str]]:
    rules: List[Dict[str, str]] = []
    for match in re.finditer(r"(?:^|\n)\[([^\]\n]+)\]\s*:?\s*([^\n]*)", text):
        command = match.group(1).strip()
        rules.append({
            "id": Path(command).name or command,
            "command": clipped(command, 300),
            "reason": clipped(match.group(2).strip(), 1000),
        })
    if not rules:
        rules.append({"id": "stop_hook", "reason": clipped(text.replace("Stop hook feedback:", "").strip(), 1000)})
    return rules


def runtime_metadata(entry: Dict[str, Any], event: Dict[str, Any]) -> Dict[str, Any]:
    message = entry.get("message") if isinstance(entry.get("message"), dict) else {}
    usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
    numeric_usage = {
        key: int(value)
        for key, value in usage.items()
        if key in {"input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"}
        and isinstance(value, (int, float))
    }
    context_tokens = sum(numeric_usage.get(key, 0) for key in (
        "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"
    ))
    config = {}
    for key in ("permission_mode", "permissionMode", "source", "cwd"):
        if key in event and isinstance(event[key], (str, int, float, bool)):
            config[key] = event[key]
    return {
        "model": str(message.get("model") or entry.get("model") or event.get("model") or ""),
        "context_tokens": context_tokens,
        "usage": numeric_usage,
        "config": config,
    }


def current_turn(entries: List[Dict[str, Any]], event: Dict[str, Any]) -> Dict[str, Any]:
    start = -1
    for index in range(len(entries) - 1, -1, -1):
        if original_user(entries[index]):
            start = index
            break
    if start < 0:
        return {}

    seen_text = set()
    prose: List[str] = []
    thinking: List[str] = []
    tools: List[Dict[str, str]] = []
    by_id: Dict[str, Dict[str, str]] = {}
    has_chat_reply = False
    rules: List[Dict[str, str]] = []
    rewrite_reasons: List[str] = []
    rewrite_attempts = 0
    final_assistant: Dict[str, Any] = {}

    for entry in entries[start + 1:]:
        feedback = stop_feedback(entry)
        if feedback:
            # Stop hook 要求重写后，之前的 assistant prose 只是草稿，不得再与成稿拼接。
            rewrite_attempts += 1
            rewrite_reasons.append(clipped(feedback.replace("Stop hook feedback:", "").strip(), 2000))
            rules.extend(feedback_rules(feedback))
            prose = []
            thinking = []
            seen_text = set()
            final_assistant = {}
            continue
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
                    final_assistant = entry
            elif entry.get("type") == "assistant" and kind == "thinking" and part.get("thinking"):
                thinking.append(str(part["thinking"]))
                final_assistant = entry
            elif entry.get("type") == "assistant" and kind == "tool_use":
                final_assistant = entry
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

    prompt = entries[start]
    prompt_message = prompt.get("message") if isinstance(prompt.get("message"), dict) else {}
    output_message = final_assistant.get("message") if isinstance(final_assistant.get("message"), dict) else {}
    return {
        "prompt": prompt,
        "user_input": str(prompt_message.get("content") or ""),
        "content": "\n\n".join(prose).strip(),
        "thinking": "\n\n".join(item.strip() for item in thinking if item.strip()),
        "tools": tools[:40],
        "has_chat_reply": has_chat_reply,
        "rules": rules,
        "rewrite_occurred": rewrite_attempts > 0,
        "rewrite_reason": "\n\n".join(rewrite_reasons),
        "rewrite_attempts": rewrite_attempts,
        "input_message_id": str(prompt.get("uuid") or prompt_message.get("id") or prompt.get("promptId") or ""),
        "output_message_id": str(final_assistant.get("uuid") or output_message.get("id") or ""),
        "runtime": runtime_metadata(final_assistant, event),
    }


def main() -> int:
    event = read_event()
    # This file is registered only under Stop. Remote Control builds do not all
    # expose hook_event_name consistently, so do not use its absence as a gate.
    if event.get("stop_hook_active") is True or event.get("stopHookActive") is True:
        log_status("skipped_stop_hook_active")
        return 0
    base = str(os.environ.get("MUWEN_URL") or "https://ci-hours-2.onrender.com").rstrip("/")
    token = str(os.environ.get("MUWEN_TOKEN") or "010219")
    session_id = str(event.get("session_id") or event.get("sessionId") or "")
    if not base or not token or not session_id:
        log_status("skipped_missing_route", has_session=bool(session_id))
        return 0

    transcript_path = str(event.get("transcript_path") or event.get("transcriptPath") or "")
    turn = current_turn(tail_entries(transcript_path), event)
    prompt = turn.get("prompt") or {}
    content = str(turn.get("content") or "")
    thinking = str(turn.get("thinking") or "")
    tools = turn.get("tools") if isinstance(turn.get("tools"), list) else []
    has_chat_reply = turn.get("has_chat_reply") is True
    if not content:
        content = str(event.get("last_assistant_message") or event.get("lastAssistantMessage") or "").strip()
    if not content:
        log_status("skipped_no_content", has_transcript=bool(transcript_path))
        return 0
    turn_id = str(event.get("turn_id") or event.get("turnId") or prompt.get("promptId") or "")
    digest = hashlib.sha256((session_id + "\0" + turn_id + "\0" + content).encode("utf-8", "replace")).hexdigest()
    body = json.dumps({
        "session_id": session_id,
        "mirror_key": "claude:" + digest,
        "content": content,
        "thinking": thinking,
        "tools": tools,
        "from_muwu": from_muwu(prompt),
        "has_chat_reply": has_chat_reply,
        "turn_id": turn_id,
        "user_input": str(turn.get("user_input") or ""),
        "input_message_id": str(turn.get("input_message_id") or ""),
        "output_message_id": str(turn.get("output_message_id") or ""),
        "runtime": turn.get("runtime") or {},
        "thinking_present": bool(thinking.strip()),
        "thinking_chars": len(thinking),
        "rules": turn.get("rules") or [],
        "rewrite_occurred": turn.get("rewrite_occurred") is True,
        "rewrite_reason": str(turn.get("rewrite_reason") or ""),
        "rewrite_attempts": int(turn.get("rewrite_attempts") or 0),
    }, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        base + "/api/chat/claude-mirror",
        data=body,
        headers={"Content-Type": "application/json", "x-access-token": token, "x-muwu-session-id": session_id},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            log_status(
                "sent", http_status=response.status, from_muwu=from_muwu(prompt), tools=len(tools),
                rewrite=turn.get("rewrite_occurred") is True,
                rewrite_attempts=int(turn.get("rewrite_attempts") or 0),
            )
    except urllib.error.HTTPError as error:
        log_status("http_error", code=error.code)
    except (OSError, urllib.error.URLError) as error:
        log_status("network_error", error=type(error).__name__)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
