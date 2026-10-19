#!/usr/bin/env python3
import importlib.util
import json
import tempfile
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

# Hook feedback arrives after the draft, but before the rewritten assistant: never
# fall back to last_assistant_message or leak the invalid draft.
waiting = module.current_turn(entries[:3], {})
assert waiting["content"] == ""
assert waiting["rewrite_occurred"] is True

# A system stop_hook_summary has the same invalidation semantics.
summary_order = [
    entries[0], entries[1],
    {"type": "system", "subtype": "stop_hook_summary", "message": {"content": "[/tmp/photo-recall-guard.js]: 请先看图"}},
    entries[3],
]
summary_turn = module.current_turn(summary_order, {})
assert summary_turn["content"] == "这是最后成稿"
assert summary_turn["rewrite_attempts"] == 1
assert summary_turn["rules"][0]["id"] == "photo-recall-guard.js"

# Two blockers may complete in either order. Only prose after the last feedback is final.
two_orders = [
    [entries[0], entries[1], entries[2], entries[3],
     {"type": "user", "isMeta": True, "message": {"content": "Stop hook feedback:\n[/tmp/second.py]: 再写一次"}},
     {"type": "assistant", "uuid": "a-final-2", "message": {"content": [{"type": "text", "text": "第二次最后成稿"}]}}],
    [entries[0], entries[1],
     {"type": "user", "isMeta": True, "message": {"content": "Stop hook feedback:\n[/tmp/second.py]: 再写一次"}},
     entries[2],
     {"type": "assistant", "uuid": "a-final-2", "message": {"content": [{"type": "text", "text": "第二次最后成稿"}]}}],
]
for ordered in two_orders:
    ordered_turn = module.current_turn(ordered, {})
    assert ordered_turn["content"] == "第二次最后成稿"
    assert ordered_turn["rewrite_attempts"] == 2

# If mirror is invoked before the active keyword interceptor, it preflights the
# interceptor's own matcher. This makes finality independent of Stop hook order.
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    blocker = root / "no-template-talk.py"
    blocker.write_text("def find_violations(text):\n    return ['bad'] if '待改写' in text else []\n", encoding="utf-8")
    settings = root / "settings.json"
    settings.write_text(json.dumps({"hooks": {"Stop": [{"hooks": [
        {"type": "command", "command": f"python3 {blocker}"},
        {"type": "command", "command": "python3 /tmp/claude-chat-mirror.py"}
    ]}]}}), encoding="utf-8")
    assert module.known_blocker_reasons("这句待改写", "s1", [settings]) == ["no-template-talk.py"]
    assert module.known_blocker_reasons("这是最后成稿", "s1", [settings]) == []

print("claude-chat-mirror: ok")
