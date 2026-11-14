# 木屋 / Sigh 通话升级草案 · 2026-11-13

状态：后端完整自动测试已通过；**尚未部署，Mac mini 接入与真机音频验收尚未完成**。部署完成后以 `/health` 中 `call_upgrade: 1` 与 `call_audio_formats` 确认服务器版本。

## 本轮范围

| 内容 | 当前实现 |
|---|---|
| 接话等待 | 通话桥 balanced 不再额外攒 350ms；原生端消费 24kHz PCM 流，约 80ms 一块交给播放节点，不等整句下载；保留原来的 ElevenLabs 音色、语言与模型配置 |
| 回声、背景误收 | Sigh 用同一个 AVAudioEngine 做 voice processing 和辞的实际播放，提供回声参考；分段前保留 0.4s，限制最长 45s；高置信非语音片段可舍弃。电视里的对话与人声混杂仍需真机验证，不能保证完全辨认说话人 |
| 一边通话一边听媒体 | mixWithOthers + 系统 advanced ducking，用户或远端说话时媒体变轻，安静时由系统恢复；不同耳机、蓝牙和其他媒体 App 的行为仍需实测 |
| 字幕大小 | 原生 13–34pt 滑杆、即时预览、记住设置；缩小通话条也随字号调整；记录区可滚动，操作键保持可见 |
| 环境音 | 可单独开启；本机 SoundAnalysis 分类后发送有限的中文声音观察，带 call_id 与 system 来源；两次窗口一致、置信阈值、去重与冷却；静音暂停；不保存环境录音，不识别人名或推断活动 |
| 重要片段 | 从实时/历史通话选 1–30 句，保存原文字、时间和通话身份；独立用户收藏页。此版是文字片段收藏，**未实现原通话录音收藏**，没有把重新生成的 TTS 当原声 |
| 情绪 | 真实区分 ready / neutral / uncertain / too_short / failed；允许没有标签；用户纠正优先；支持通话逐句纠正及现有语音留言纠正；标记“不是我说的”后不再以 Nor 原话进入文字历史/记忆 |
| 输入来源 | 独立 muwu-chat / muwu-voice / muwu-call / muwu-system MCP channels；StackChan 留给硬件；保留消息类型、call_id、owner_session_id 和 reply_tool；系统观察不算用户活跃 |

## 后端接口与不变量

- `/api/call/transcribe`、`/api/call/say` 接受 `call_id`、`segment_id`。录音上传前与 STT 完成后都核对原通话；同片段重试不产生第二句。
- 旧客户端没有 call_id 时，服务端在接收录音时绑定当前电话，完成时仍核对这一通。原生端绑定更早，在采集时就确定身份。
- `/api/call/audio/:eventId?format=pcm_24000` 返回 S16LE 单声道 24kHz，响应标头 `X-Audio-Format: pcm_24000`。默认仍为 MP3，兼容旧客户端；播放断开会取消上游。
- `/api/call/ambient` 只接收枚举声音标签和置信估计，不接收任意“用户原话”；生成系统事件，不进入通话 utterance 文字历史。
- `/api/call/events/:id/tone`、`/voice-label`、`/api/call/voice-tone/items` 提供异步分析与纠正。晚到结果只关联原句，不能进入下一通电话。机器结果不覆盖人的纠正。
- `/api/call/favorites` GET/POST 和 DELETE `/:id` 为用户私有文字收藏，没有加进辞的 MCP 收藏接口。
- 通话继续属于发起/选定的窗口，包括并行窗口；不更换主会话，也不向主窗口写入心潮状态。

## Mac mini 集成：尚未执行

当前工作区连接 Mac mini 的局域网 SSH 返回 `Operation not permitted`，mDNS 名称也未解析；这不能证明设备离线。手机 CoreDevice 的 XPC 服务也无法访问。不能把本地副本视为运行中的文件。本次没有修改 `/Users/nor/Claude` 或任何运行会话。

1. 先在 Mac mini 备份并核对现用 `voice-channel.mjs`、calls addon、hooks、启动配置与 HerVoice 模块。不要替换任何人格/身份文件。
2. 后端先部署：旧 Sigh 继续收到 MP3；新 Sigh 需要 PCM 接口部署后才能安装。
3. 把三个新的 `muwu-input-*.mjs` / calls addon 放到已有 MCP SDK 能解析的位置。与现有 `parallel-recall-mcp.mjs` 使用同一套 SDK。
4. 为每个入口注册独立 stdio MCP server，命令 `node /实际目录/muwu-input-channel.mjs`，环境配置 `MUWU_CHANNEL`（四个名称之一）、`MUWU_URL`、`MUWU_TOKEN`、`MUWU_SESSION_ID`。令牌沿用本机配置，不写入文档或仓库。主窗口加载四个入口；并行窗口只加载 call/system，后端继续校验身份。
5. **必须先关旧 StackChan 文件内的木屋聊天轮询与通话轮询，再启用新入口**，否则会重复投递。保留硬件麦克风与婴儿房逻辑。现用 worker 不在本仓库，不能用 9 月下载副本盲目覆盖。核对其 `pollMuwu` 和 `startCallBridge` 调用，分别加可回滚开关，或移除对应调用。
6. 合并与测试 mirror / tool-only display / recall hooks；本仓库已兼容新来源。保留本机额外的既有保护和配置，不能用仓库版本盲目覆盖本机不同的 hook。另核对本机 session_host 的活跃计时实现：只有真正的 Nor 输入重置计时，`muwu-system` 和 `counts_as_user_activity=false` 不得重置。
7. 异步 HerVoice adapter：`python3 /实际目录/hervoice-call-worker.py`，环境复用 MUWU_URL/MUWU_TOKEN，`HERVOICE_MODULE` 指向已核对的现用 hervoice.py。它复用该模块的声学提取、个人基线和 LLM 配置，不要求新云服务密钥；处理通话和木屋语音留言。启动前核对所需 `_acoustic_features / _acoustic_probs / _tone / _llm / TAGS`，同一来源只运行一份分析 worker，避免旧 worker 重复覆盖。
8. 分入口重启对应 MCP 连接，确认真实 transcript 的 `origin.server` 也是新名称，而不是仅在旧 StackChan 内容里加标签。保留现有主窗口及并行窗口身份和路由。
9. 最后构建/安装 Sigh，用真实扬声器、听筒和蓝牙逐项试听。失败先退回旧 App 和旧入口，不清空聊天、电话记录或记忆。

## 验证

已通过：

- 完整 `npm test`（含 HTTP smoke、既有回归、通话接口和新桥接行为测试）；使用了本地 Mac 运行脚本快照做独立源检查。
- `/health` 的版本能力标记，供安装新版 App 前确认后端支持 PCM。
- Docker 构建改为 `npm ci`，部署使用已经测试的锁定依赖。

- `node test/call-upgrade.mjs`：电话身份、重试、窗口隔离、观察来源、纠正、历史、收藏。
- `node test/call-stream.mjs`：首块先于整句到达、PCM 字节与标头、取消上游。
- `node test/history-main.mjs`、`node test/chat-schema.mjs`：既有主历史与消息结构回归。
- `python3 test/hervoice-call-worker.py`：4 项边界/提示数据测试。这不是情绪准确率评估。
- JS 语法检查、Python 编译检查、`git diff --check`。
- Sigh iOS 18 arm64 SDK 全部 Swift 源码 typecheck。

联调环境：重新按 package-lock 安装依赖，排除了旧 node_modules 云端占位文件造成的启动等待。桥接延迟改用行为测试；外部 Mac 脚本审计使用显式 `MUWEN_MAC_RUNTIME_ROOT`，不依赖仓库外固定目录。

未通过验收或被环境阻塞：

- Xcode 整包构建：资源编译报 `No available simulator runtimes` / CoreSimulator 服务不可用；模拟器和 generic iOS 尝试均受影响。没有生成可安装的新 App。
- Mac mini 入口切换、实际 HerVoice 兼容性、真机 AEC、媒体恢复、耳机切换、锁屏/中断恢复、实际首音延迟和情绪准确率尚未验证。

## 真机验收重点

安静轻声、辞扬声器独白不插入 Nor 转写、两人同时讲话、旁人/电视声音、音乐持续播放与静音恢复、蓝牙切换、长句断句、挂断后立即重拨、断网重试、同句只播一次、并行窗口接听、无明显情绪与人工纠正、环境音开关/重复提示、最大字幕下操作键可见、收藏重启后仍在。

此版不改模型人格、不强制每句生成情绪、不承诺识别全部环境声音。实测后再判断是否需要持续实时 ASR、声纹或更强的声音描述模型。
