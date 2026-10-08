#!/usr/bin/env python3
"""Hide Claude Code's duplicate terminal prose for Muwu channel turns.

Muwu text/voice messages and calls are injected into the current interactive
Claude Code session through the ``stackchan-voice`` channel.  Claude answers
the phone/UI through MCP tools (``chat_reply`` / ``call_say``), but Claude Code
still renders any assistant prose that follows the tool call in the terminal.

This MessageDisplay hook replaces that rendered prose with an empty string only
when the current turn originated from Muwu.  It does not alter the transcript or
Claude's context.  Human prompts typed directly in the terminal are untouched.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional


MAX_SCAN_BYTES = 32 * 1024 * 1024
READ_CHUNK_BYTES = 64 * 1024
MAX_CACHE_ENTRIES = 32


def read_event() -> Dict[str, Any]:
    try:
        value = json.load(sys.stdin)
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def is_muwu_prompt(entry: Dict[str, Any]) -> bool:
    if entry.get("type") != "user":
        return False

    origin = entry.get("origin")
    if not isinstance(origin, dict):
        return False
    if origin.get("kind") != "channel" or origin.get("server") != "stackchan-voice":
        return False

    message = entry.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or "<channel " not in content:
        return False
    return 'origin="muwu"' in content or 'origin="muwu_call"' in content


def matching_prompt(transcript_path: str, turn_id: str) -> Optional[Dict[str, Any]]:
    """Find this turn's top-level user prompt without loading a large transcript."""
    if not transcript_path or not turn_id:
        return None

    path = Path(transcript_path)
    try:
        size = path.stat().st_size
    except OSError:
        return None

    turn_bytes = turn_id.encode("utf-8")
    position = size
    scanned = 0
    partial = b""

    try:
        with path.open("rb") as handle:
            while position > 0 and scanned < MAX_SCAN_BYTES:
                amount = min(READ_CHUNK_BYTES, position, MAX_SCAN_BYTES - scanned)
                position -= amount
                handle.seek(position)
                block = handle.read(amount) + partial
                scanned += amount

                lines = block.split(b"\n")
                if position > 0:
                    partial = lines.pop(0)
                else:
                    partial = b""

                for raw in reversed(lines):
                    if turn_bytes not in raw:
                        continue
                    try:
                        entry = json.loads(raw)
                    except Exception:
                        continue
                    message = entry.get("message")
                    # Tool results are also stored as role=user and inherit the
                    # same promptId.  Keep walking back to the original prompt,
                    # whose content is a string (tool_result content is a list).
                    if (entry.get("type") == "user"
                            and entry.get("promptId") == turn_id
                            and isinstance(message, dict)
                            and isinstance(message.get("content"), str)):
                        return entry
    except OSError:
        return None

    return None


def cache_path(session_id: str) -> Path:
    digest = hashlib.sha256(session_id.encode("utf-8", "replace")).hexdigest()[:20]
    return Path(tempfile.gettempdir()) / ("claude-muwu-display-" + digest + ".json")


def load_cache(path: Path) -> Dict[str, bool]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(value, dict):
        return {}
    return {str(k): bool(v) for k, v in value.items()}


def save_cache(path: Path, values: Dict[str, bool]) -> None:
    trimmed = dict(list(values.items())[-MAX_CACHE_ENTRIES:])
    temporary = path.with_name(path.name + "." + str(os.getpid()) + ".tmp")
    try:
        temporary.write_text(json.dumps(trimmed, separators=(",", ":")), encoding="utf-8")
        temporary.replace(path)
    except OSError:
        try:
            temporary.unlink()
        except OSError:
            pass


def should_hide(event: Dict[str, Any]) -> bool:
    session_id = str(event.get("session_id") or "")
    turn_id = str(event.get("turn_id") or "")
    transcript_path = str(event.get("transcript_path") or "")
    if not session_id or not turn_id:
        return False

    path = cache_path(session_id)
    values = load_cache(path)
    if turn_id in values:
        return values[turn_id]

    prompt = matching_prompt(transcript_path, turn_id)
    hidden = is_muwu_prompt(prompt or {})
    values[turn_id] = hidden
    save_cache(path, values)
    return hidden


def main() -> int:
    event = read_event()
    if event.get("hook_event_name") != "MessageDisplay" or not should_hide(event):
        return 0

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "MessageDisplay",
            "displayContent": "",
        }
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
