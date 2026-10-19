#!/usr/bin/env python3
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("claude_chat_mirror", ROOT / "hooks" / "claude-chat-mirror.py")
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(module)

entries = [
    {"type": "user", "uuid": "u1", "message": {"content": "你实际怎么看？"}},
    {"type": "assistant", "uuid": "a-draft", "message": {"model": "claude-test", "content": [
        {"type": "thinking", "thinking": "draft hidden"},
        {"type": "text", "text": "重写前草稿"},
    ]}},
    {"type": "user", "isMeta": True, "message": {"content": "Stop hook feedback:\n[/Users/nor/.claude/hooks/no-template-talk.py]: 检测到模板化表达"}},
    {"type": "assistant", "uuid": "a-final", "message": {"model": "claude-test", "usage": {"input_tokens": 10, "output_tokens": 5}, "content": [
        {"type": "thinking", "thinking": "final hidden"},
        {"type": "text", "text": "这是最后成稿"},
    ]}},
]

turn = module.current_turn(entries, {"permission_mode": "default"})
assert turn["content"] == "这是最后成稿"
assert "重写前草稿" not in turn["content"]
assert turn["thinking"] == "final hidden"
assert turn["rewrite_occurred"] is True
assert turn["rewrite_attempts"] == 1
assert turn["rules"][0]["id"] == "no-template-talk.py"
assert turn["input_message_id"] == "u1"
assert turn["output_message_id"] == "a-final"
assert turn["runtime"]["context_tokens"] == 10
assert module.original_user(entries[0]) is True
assert module.original_user(entries[2]) is False

print("claude-chat-mirror: ok")
