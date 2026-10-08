# 木纹配套的 Claude Code hooks

> ⚠️ **Windows PowerShell 5.1 读 .ps1 必须带 UTF-8 BOM。** 不带的话会按系统 ANSI（中文 Windows 是 GBK）读，
> 脚本里的中文注释/字符串一乱，后面的代码就跟着解析错。2026-09-13 实测：`timestamp.ps1` 没 BOM，
> 每条消息都报 `timestamp.ps1:15` 钩子错误，时间戳不注入、`last_wakeup.txt` 不更新，看门狗会误推"窗口挂了"。
> 本目录的 .ps1 都已经带 BOM；拷到 GPD 时用二进制方式拷（别用会重新编码的编辑器另存）。

这些脚本跑在辞所在的那台机器（Claude Code 客户端）上，不是服务器的一部分。

| 文件 | 挂在哪 | 干什么 |
|---|---|---|
| `pre-compact-ring.mjs` | `PreCompact` | 压缩前把这个窗口的对话原文自动存进年轮（`add_ring`，`source_type=auto_extract`）。年轮层 auto_extract 类型的来源就是它。 |
| `user-prompt-recall.ps1` | `UserPromptSubmit` | 自动召回注入：棋子每条消息调木纹 `POST /api/recall`，把匹配到的 3–5 条记忆作为额外 context 注入（`[muwen:recall] …`）。琐碎消息跳过；网络慢/失败静默。 |
| `chat-annotate.py` | `PostToolUse`（matcher `mcp__muwen__chat_reply`） | 辞回木屋消息之后，从会话记录取这一轮真实的 thinking 和工具调用补到那条消息上（棋子那边显示成 Thought process / Used N tools）。静默失败，不记日志。 |
| `claude-image-to-album.py` | `PostToolUse`（matcher `mcp__muwen__save_claude_image`） | 辞在 Claude 端决定收藏棋子发来的图片后，从当前 session 的原始记录读取最近一张用户图片，存进与木屋共用的相册；不要求模型复制 base64。 |
| `muwu-tool-only-display.py` | `MessageDisplay` | 木屋文字/语音（`muwu`）和通话（`muwu_call`）回合只在木屋显示工具回复，不再在终端重复显示 assistant 文字。只是隐藏终端渲染，原文仍完整留在当前 session；终端里直接输入的正常对话不受影响。 |

## 木屋实时通话（GPD）

把 `voice-channel-calls-addon.mjs` 放到 GPD 的 `voice-channel.mjs` 同目录。在原文件 import 区增加：

```js
import { startCallBridge } from './voice-channel-calls-addon.mjs'
```

在 `const MUWU = loadMuwu()` 之后增加：

```js
startCallBridge({ mcp, muwu: MUWU, safeMeta, log })
```

它复用原来的 `.muwu.json`、MCP channel 和当前 Claude Code session，每秒取一次通话事件；不会改变原来的房间麦克风和普通留言轮询。
启动 Claude 前必须设置 `MUWU_SESSION_ID=<当前 session UUID>`。聊天和通话领取请求都会带这个 ID，后端只把事件交给换窗工作台登记的主要窗口；副窗口即使在线也拿不到，缺少 ID 时频道保持关闭。
| `prune-injections.py` | `UserPromptSubmit` | 阅后即焚：木纹注入进对话的召回内容（以 `[muwen:<类型>]` 开头）每类只留最新一条，旧的 content 清成 `[""]` 留空壳保链。顺序无关，Windows 用 msvcrt 锁。 |

`~/.claude/settings.json` 示例：

```json
{
  "hooks": {
    "PreCompact": [{ "hooks": [{ "type": "command",
      "command": "MUWEN_URL=https://ci-hours-2.onrender.com MUWEN_TOKEN=<ACCESS_PASSWORD> MUWEN_WINDOW=Code主窗口 node /ABS/PATH/hooks/pre-compact-ring.mjs" }] }],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\Users\\<你>\\.claude\\hooks\\user-prompt-recall.ps1" }] },
      { "hooks": [{ "type": "command", "command": "python3 /ABS/PATH/hooks/prune-injections.py" }] }
    ],
    "MessageDisplay": [
      { "hooks": [{ "type": "command", "command": "python3 /ABS/PATH/hooks/muwu-tool-only-display.py", "timeout": 2 }] }
    ]
  }
}
```

`user-prompt-recall.ps1`（自动召回）和 `prune-injections.py`（阅后即焚）配套：前者每条消息注入一段 `[muwen:recall] …`，后者保证这类注入只留最新一条不堆积。Windows 上时间戳钩子 `timestamp.ps1` 也在 UserPromptSubmit 下并列，多个 hook 会都跑。

注入的召回内容如果用别的 hook 自己写，开头要带 `[muwen:recall]` 这种前缀，`prune-injections.py` 才认得出来该清哪些；`pre-compact-ring.mjs` 也靠这个前缀避免把注入内容再存回年轮（套娃）。

设计文档里还提到的"保温 tick"（heartbeat 加 WARM_ONLY 轻 tick）属于 heartbeat 系统，不在这个仓库里，没有对应文件。
