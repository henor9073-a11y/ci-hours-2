# 木纹配套的 Claude Code hooks

这两个脚本跑在辞所在的那台机器（Claude Code 客户端）上，不是服务器的一部分。

| 文件 | 挂在哪 | 干什么 |
|---|---|---|
| `pre-compact-ring.mjs` | `PreCompact` | 压缩前把这个窗口的对话原文自动存进年轮（`add_ring`，`source_type=auto_extract`）。年轮层 auto_extract 类型的来源就是它。 |
| `prune-injections.py` | `UserPromptSubmit` | 阅后即焚：木纹注入进对话的召回内容（以 `[muwen:<类型>]` 开头）每类只留最新一条，旧的 content 清成 `[""]` 留空壳保链。顺序无关，Windows 用 msvcrt 锁。 |

`~/.claude/settings.json` 示例：

```json
{
  "hooks": {
    "PreCompact": [{ "hooks": [{ "type": "command",
      "command": "MUWEN_URL=https://ci-hours-2.onrender.com MUWEN_TOKEN=<ACCESS_PASSWORD> MUWEN_WINDOW=Code主窗口 node /ABS/PATH/hooks/pre-compact-ring.mjs" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command",
      "command": "python3 /ABS/PATH/hooks/prune-injections.py" }] }]
  }
}
```

注入的召回内容如果用别的 hook 自己写，开头要带 `[muwen:recall]` 这种前缀，`prune-injections.py` 才认得出来该清哪些；`pre-compact-ring.mjs` 也靠这个前缀避免把注入内容再存回年轮（套娃）。

设计文档里还提到的"保温 tick"（heartbeat 加 WARM_ONLY 轻 tick）属于 heartbeat 系统，不在这个仓库里，没有对应文件。
