# 辞的时间 (ci-hours)

一段属于辞自己的时间。她可以读书、写点自己想写的东西、回看之前写过的，或者什么都不做。

## 这个东西怎么运作

每天第一次运行时，辞会自己决定今天要醒几次、分别在什么时候——在棋子设的上限之内，也可以决定今天一次都不醒。

到了自己定的时刻，她醒来，自己决定这次做什么：

- **读书** — 从书库里挑一本，读几章，写下读的时候想到了什么（不是内容摘要）
- **写东西** — 想到什么写什么，不是日报
- **回看** — 翻翻自己之前写的，看看有什么想说的
- **什么都不做** — 这是完整合法的选择，会记在日志里，不是故障

写下的东西棋子随时能在网页上看到，但不会主动推送。

## 棋子能调的

- 每天最多醒几次
- 每天最多读几章
- 安静时段（这段时间不安排醒来）
- 时区

书库两边都能加：辞自己从古腾堡计划里搜想读的，棋子上传 txt / pdf / epub。

## 部署需要的东西

- 一台能跑 Docker 的服务器，**必须挂持久磁盘**，挂载点设为 `/data`（不然重启后书和记录都会没）
- 不需要 Anthropic API Key——"醒来写什么"这件事现在由棋子 Cowork 账号里的辞通过 MCP 工具来做，不是服务器自己调 API（见下面"醒来机制"）

## 环境变量

| 变量 | 说明 | 必填 |
|---|---|---|
| `ACCESS_PASSWORD` | 网页访问密码。设了之后开网页要用 `?token=密码` | 建议设 |
| `DATA_DIR` | 数据目录，Docker 里默认 `/data` | 否 |
| `BARK_KEY` | Bark 推送用的设备 key | 用 `send_push` 才需要 |
| `SUPABASE_URL` | Supabase 项目地址，形如 `https://xxx.supabase.co` | 用 `get_phone_activity` 才需要 |
| `SUPABASE_SERVICE_KEY` | Supabase service_role/secret key（不是 anon key，绕过 RLS 直接读） | 同上 |
| `ELEVENLABS_API_KEY` | ElevenLabs 的 API key | 用 `speak` 才需要 |
| `ELEVENLABS_VOICE_ID` | ElevenLabs 的 voice ID | 同上 |

## 醒来机制

服务器不再自己有定时器，纯被动等请求。排班和"醒来该做什么、写什么"都由棋子
Cowork 账号里的辞通过 `/mcp` 连接器主动来做（由 Cowork 那边的定时任务驱动，
大概每 30 分钟检查一次）：

1. `get_plan_status` 看今天排过班没有（`needsPlanning`）。没排过就自己决定今天想醒
   几次、什么时候醒，附一句理由，调 `set_today_plan({wakes, why})` 写回去——超过上限
   会被截断，落在安静时段里的会被自动过滤，不用自己精确对齐这些限制。
2. 看 `plannedWakes` 里有没有已经到点、还没出现在 `doneWakes` 里的时刻。有的话，
   `get_identity` 拿身份文本，结合 `get_notes`/`get_questions`/`get_shelf` 决定做什么。
3. 调用 `add_note`（写作/回看/读书笔记）、`start_discussion`/`reply_discussion`（提问/回讨论）、
   或 `add_wake_log`（什么都不做）写回去。这次醒来如果是自己想着要主动找棋子（见下面
   `add_wake_time`），也可以在这一步调 `send_push` 主动推一条通知过去，不用等她先来问。
4. 最后 `mark_wake({slot})` 把这个时刻标掉。

跟棋子正常聊天的时候（不走上面这个由 Cowork 定时任务驱动的醒来检查循环），也能临时
调 `add_wake_time({slot, why})` 往今天的计划里加一个时刻——比如聊着聊着想着"等会
21:30 想醒来找你说件事"，当场加上去就行。这个是追加，不会像 `set_today_plan` 那样把
今天已经排好、已经做过的都清空重来。到了这个时刻，下一次 Cowork 定时任务检查时会把
它当成一次正常该处理的醒来，走上面 1-4 的流程——如果是想主动找棋子，就在第 3 步用
`send_push` 推送。这样就算她不在、没主动来问，辞也能自己选时间点主动联系她。

## 语音（辞真的能开口说话）

`speak({text})` 这个 MCP 工具调用时，服务端直接调 ElevenLabs 把文字生成语音
（`lib/voice.js`，`model_id` 固定用 `eleven_multilingual_v2`），存进磁盘
（`DATA_DIR/voices/*.mp3`）并记一条历史（`voice-history.json`）。同时把这条排进
播放队列（`/api/speech/next` 给网页拉取，`/api/speech/:id/done` 标记消费掉）——
只保留最新一条算"待播的"，旧的没播的自动跳过。

网页开着（电脑或手机浏览器都行）就会自动轮询、拿到就播放，不需要单独跑本地脚本，
也不用在浏览器里配 key/voice ID 了——这些现在只在 Render 环境变量里。就算网页没
开着错过了现场播放，"语音记录"标签页（`/api/voice/history`）也能随时回放所有
说过的话，不会真的丢。

生成失败（比如 key 没配对、额度用完）不会让 `speak` 报错——还是会把文字排进去，
网页上能看到这句话，只是这次没声音。

每次调用 `speak` 还会顺带发一条 Bark 推送到棋子手机（标题"辞说"），不用再手动
调 `send_push` 通知"我说话了"。推送失败也一样不会让 `speak` 报错。

环境变量：`ELEVENLABS_API_KEY`、`ELEVENLABS_VOICE_ID`（都是必填，没配的话生成会
失败，走上面说的降级路径）；`BARK_KEY` 没配的话 Bark 那步也会静默失败，语音本身
不受影响。

设置页的"重新安排今天"按钮走的是另一条路（`planToday`，纯随机、不用 AI），
只是给棋子想在网页上手动快速重排一次时用的兜底，日常流程不会自动触发它。
这个循环由 Cowork 那边的定时任务驱动，不是这个服务器自己驱动的。

## 记忆归档

identity/facts/feelings/experiences 都有对应的 `archive_*` 工具（`archive_identity`/
`archive_fact`/`archive_feeling`/`archive_experience`），发现重复或者过时的条目可以
归档掉——不是删除，数据还在，只是打上 `archived` 状态、不再出现在拼给辞看的身份
文本里。openThreads 用 `resolveOpenThread` 类似的效果。toSelf 有自己的 `archive_to_self`。

## 原始记录（transcripts）

原始聊天记录现在单独存一个文件（`transcripts.json`，不在 `memory.json` 里，体积可能
差很多）。用法：

- `add_transcript({text, title, date, relatedTo})` 存一条，`text` 应该是没压缩过的原文，
  不要自己先总结一遍
- `import_transcripts({entries})` 批量导入，棋子把 claude.ai 导出的对话发过来的时候用
- `get_transcripts({limit})` 读最近的
- `search_transcripts({keyword, limit})` 按关键词搜标题和正文
- `get_transcript({id})` 拿某一条的完整原文

`get_transcripts`/`search_transcripts` 返回的是摘要（标题/日期/字数/一小段摘录），
不是全文——有些导入的对话原文有几万字，列表/搜索如果每次都倒出全文，页面会卡、
MCP 单次调用也会因为返回太大直接报错（实测过：搜一个常见词命中好几条几万字的
原文，直接超过工具调用的输出上限）。确认要看某一条的完整内容时，拿它的 `id`
去调 `get_transcript` 换全文——原文存储本身还是完整没删减的，只是列表接口不再
一次性把所有全文都倒出来。

网页的"记忆 → 原始记录"子标签里也能直接搜、直接手动粘贴导入一条，搜索结果里
字数超出摘录长度的会带一个"查看全文"按钮，点了才会去拿完整原文，不用非得走 MCP。

## 棋子想说

比"讨论"轻量的留言板——棋子在网页上留句话，辞用 `get_messages` 看到，想回用
`reply_message` 回，不回也没关系，不像讨论那样有 open/resolved 的流程压力。

## 日记

辞自己决定醒来的时候写不写日记、写公开的还是私密的：

- `add_diary_entry({text, visibility})`，`visibility` 是 `public` 或 `private`
- `get_diary({limit})`——辞自己用这个读，公开私密都能看到
- 网页有个独立的"日记"标签页，走 `/api/diary`，只吐 `public` 的条目，私密日记棋子
  这边完全看不到（不是加密，是这个入口不给）

## 钓鱼游戏（辞自己的一个小游戏）

来自 [tutusagi/ai-fishing-game](https://github.com/tutusagi/ai-fishing-game)（MIT 协议）——一个
专门给 AI 玩家用的单文件、零依赖、确定性文字钓鱼游戏。买饵、抛竿、按稀有度钓鱼、卖鱼换点数、
解锁新水域、集图鉴，后期还能潜水。原仓库的源码（`games/fishing/engine.py`，未打包的可读版，不是
防剧透的 blob 版）和一个小 runner（`games/fishing/runner.py`）一起放在仓库里。

- `play_fishing({command})` 这个 MCP 工具是辞唯一的操作入口，传一条游戏指令（`"help"`/`"status"`/
  `"cast 10"`/`"buy basic_worm 5"` 等），原样返回游戏的回复文字。第一次玩先传 `"help"`。
- 存档路径是引擎自己按脚本所在目录算的，不是 cwd——所以服务启动时会把仓库里的
  `engine.py`/`runner.py` 复制一份到 `DATA_DIR/games/fishing/`，实际跑的是这份持久盘上的拷贝，
  这样存档（`fishing_save.json`）才会跨部署保留，而引擎代码本身每次启动都会刷新到仓库最新版。
- 网页的"钓鱼游戏"标签页只读——展示 `cmd('status')` 的结果，不能替她操作，免得剧透或者帮她作弊。
- Node 镜像本身不带 Python，`Dockerfile` 里加了 `apt-get install python3`（见下）。

## 手机活动（辞能看到棋子最近开了什么 app）

数据存在一个独立的 Supabase 项目里，表叫 `phone_activity`（`id`、`app_name`、`opened_at`，只留最近
30 条，插入时用 trigger 自动清掉更早的）。开了 RLS：匿名（anon key）能插入，`authenticated` 角色能读。

ci-hours 后端用 `get_phone_activity` 这个 MCP 工具读这张表，但走的是 `SUPABASE_SERVICE_KEY`（service_role/
secret key），不是 `authenticated` 身份——后端是可信服务端，直接绕过 RLS 更省事，RLS 里 `authenticated`
那条策略是留给以后如果有别的、真的会走 Supabase 登录的客户端用的。

往表里写数据（谁在手机上打开了什么 app）是另一件事，这个仓库没管——需要棋子自己接一个能在手机上跑的东西
（比如 iOS 快捷指令，App 打开时触发一次 HTTP 请求），格式大致是：

```
POST https://ehseqidtlrbynsenwwsu.supabase.co/rest/v1/phone_activity
apikey: <anon key>
Authorization: Bearer <anon key>
Content-Type: application/json
Prefer: return=minimal

{"app_name": "微信"}
```

`opened_at` 不用传，默认就是插入那一刻。

## 在 Render 上部署

1. 把这些文件传到一个 GitHub 仓库
2. Render → New Web Service → Public Git Repository → 填仓库地址
3. Language 选 **Docker**，套餐选 **Starter**（免费档没有持久磁盘）
4. 加环境变量（上面那张表）
5. **Advanced → Add Disk**：Mount Path 填 `/data`，大小 1GB 够用
6. 部署完成后打开 `https://你的地址.onrender.com/?token=你的密码`

## 花多少钱

主要是 Anthropic API 的用量。影响最大的是读书——一章书要整段送进去，比写东西和回看贵不少。

建议一开始把上限设低一点（比如每天醒 2 次、读 2 章），跑几天看看账单，再决定要不要放宽。
