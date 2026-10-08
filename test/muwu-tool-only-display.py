#!/usr/bin/env python3
"""Small behavior test for hooks/muwu-tool-only-display.py."""

import json
import os
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "hooks" / "muwu-tool-only-display.py"


def run_case(origin, content, hidden):
    with tempfile.TemporaryDirectory() as folder:
        transcript = Path(folder) / "session.jsonl"
        turn_id = "turn-" + os.urandom(6).hex()
        entry = {
            "type": "user",
            "promptId": turn_id,
            "origin": origin,
            "message": {"role": "user", "content": content},
        }
        transcript.write_text(json.dumps(entry) + "\n", encoding="utf-8")
        event = {
            "hook_event_name": "MessageDisplay",
            "session_id": "session-" + os.urandom(6).hex(),
            "turn_id": turn_id,
            "transcript_path": str(transcript),
            "message_id": "message-1",
            "index": 0,
            "final": True,
            "delta": "terminal duplicate",
        }
        result = subprocess.run(
            ["/usr/bin/python3", str(HOOK)],
            input=json.dumps(event), text=True, capture_output=True, check=True,
        )
        if hidden:
            output = json.loads(result.stdout)
            assert output["hookSpecificOutput"]["displayContent"] == ""
        else:
            assert result.stdout == ""


channel = {"kind": "channel", "server": "stackchan-voice"}
run_case(channel, '<channel source="stackchan-voice" origin="muwu" kind="voice">hello</channel>', True)
run_case(channel, '<channel source="stackchan-voice" origin="muwu_call" kind="utterance">hello</channel>', True)
run_case(channel, '<channel source="stackchan-voice" origin="room_mic">hello</channel>', False)
run_case({"kind": "human"}, 'please explain origin="muwu"', False)
print("muwu-tool-only-display: ok")
