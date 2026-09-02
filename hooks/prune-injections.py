#!/usr/bin/env python3
"""阅后即焚 hook（设计文档注意事项 10）。

木纹通过 UserPromptSubmit hook 每轮往对话里注入记忆召回内容（以 "[muwen:<类型>]" 开头的一段文字）。
这些注入会持久化进 Claude Code 的 transcript（JSONL）堆积——实测堆积占窗口增速 37%。
这个脚本在每轮提交时清理：每类注入只留最新一条，旧的 content 清成 [""] 留空壳保链（parentUuid 不断）。

顺序无关（hooks 并行执行，配置顺序不等于执行顺序）：不管先跑还是后跑，效果都是"每类只剩最新一条"。
文件锁：POSIX 用 fcntl，Windows 用 msvcrt（原版 Python 的 fcntl 在 Windows 上没有）。

用法（~/.claude/settings.json）：
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "python3 /path/to/hooks/prune-injections.py" }] }]
stdin: Claude Code 给的 JSON，含 transcript_path。
环境变量 MUWEN_INJECT_PREFIX（默认 "[muwen:"）：注入内容的识别前缀。
"""
import json
import os
import re
import sys

PREFIX = os.environ.get("MUWEN_INJECT_PREFIX", "[muwen:")
KIND_RE = re.compile(r"^\[muwen:([^\]]+)\]")


def lock(f):
    if os.name == "nt":
        import msvcrt
        msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
    else:
        import fcntl
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)


def unlock(f):
    if os.name == "nt":
        import msvcrt
        try:
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
    else:
        import fcntl
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                return b.get("text", "")
    return ""


def kind_of(rec):
    msg = rec.get("message") or {}
    t = text_of(msg.get("content"))
    if not t.startswith(PREFIX):
        return None
    m = KIND_RE.match(t)
    return m.group(1) if m else "default"


def main():
    try:
        inp = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        inp = {}
    tp = inp.get("transcript_path")
    if not tp or not os.path.exists(tp):
        return
    lockfile = tp + ".muwen.lock"
    with open(lockfile, "a+") as lf:
        lock(lf)
        try:
            with open(tp, "r", encoding="utf-8") as f:
                lines = f.read().split("\n")
            records = []
            for line in lines:
                if not line.strip():
                    records.append((None, line))
                    continue
                try:
                    records.append((json.loads(line), line))
                except json.JSONDecodeError:
                    records.append((None, line))
            latest = {}  # kind -> index of the newest injection
            for i, (rec, _) in enumerate(records):
                if not rec:
                    continue
                k = kind_of(rec)
                if k:
                    latest[k] = i
            changed = 0
            out = []
            for i, (rec, raw) in enumerate(records):
                if not rec:
                    out.append(raw)
                    continue
                k = kind_of(rec)
                if k and latest.get(k) != i:
                    msg = rec.get("message") or {}
                    if msg.get("content") != [""]:
                        msg["content"] = [""]  # 空壳，uuid/parentUuid 都留着，链不断
                        rec["message"] = msg
                        changed += 1
                        raw = json.dumps(rec, ensure_ascii=False)
                out.append(raw)
            if changed:
                tmp = tp + ".muwen.tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    f.write("\n".join(out))
                os.replace(tmp, tp)
                print(f"[muwen] 清理了 {changed} 条旧注入", file=sys.stderr)
        finally:
            unlock(lf)


if __name__ == "__main__":
    main()
