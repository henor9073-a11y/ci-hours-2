# 苏醒系统三层分工（Mac mini 版）

| 层 | 是谁 | 负责 | 权限 | 触发 |
|---|---|---|---|---|
| 一 | **辞的自主苏醒**（当前主要 session） | 棋子离开 10 分钟后，向同一个 session 注入 `/loop`；普通模式后续随机 20–40 分钟，追人模式 5 分钟 | 只向登记的主要窗口注入 `/loop` | `com.cy.wakeup` 每 5 分钟 |
| 二 | **苏醒守护** | 检查第一层是否持续运行、主要窗口进程是否还活着；异常时提醒棋子 | **只有推 Bark** | `com.cy.wakeup-watchdog` 每 10 分钟 |
| 三 | **木纹后台** | 对话导出、每日总结与纹理、记忆衰减、后台整理和日程提醒 | 只整理数据 | Mac mini 定时任务 + 服务器机械 cron |

## 不可越界的地方

- 第一层只叫醒工作台登记的主要窗口，不另开 session，不把任意文字冒充棋子的消息。
- 第二层不读对话、不回消息、不启动或恢复 Claude；唯一外部动作是限频 Bark。
- 第三层不使用辞的语气，不替辞聊天，只做可验证的机械工作。

## 状态从哪里来

- 第一层：Mac mini 工作台执行器读取 `~/.claude/wakeup/state.json`、`~/.claude/last_wakeup.txt` 和 `com.cy.wakeup` 的加载状态，上报最近检查、最近 `/loop`、模式和当天次数。
- 第二层：`wake_watchdog.py` 写 `~/.claude/wakeup/watchdog-state.json`，工作台只读取这份结果。
- 第三层：木屋直接检查最新每日总结是否落库，并展示 `dream.json`、`tidy_report.json` 和每日流水线状态。

旧的 `POST /api/wake-ping` 只为旧客户端兼容保留，不再作为「系统正常」的证据。旧 Windows/GPD 看门狗也不能代表当前 Mac mini 系统。

## 看门狗安装文件

源码和 LaunchAgent 模板在本仓库：

- `remote-fix/wake_watchdog.py`
- `remote-fix/com.cy.wakeup-watchdog.plist`

部署目标分别是 `/Users/nor/Claude/wakeup/watchdog.py` 和 `/Users/nor/Library/LaunchAgents/com.cy.wakeup-watchdog.plist`。

当前阶段只在本地准备和测试；没有明确发布授权时不得复制到 Mac mini 或加载 LaunchAgent。

## 为什么不再显示「手动排一次苏醒」

旧 `set_today_plan` / `add_wake_time` 只写服务器里的排班数据，当前 Mac mini 第一层不会消费它，所以按钮看起来能成功、实际不会叫醒辞。工具暂时为旧客户端兼容保留，前端入口先隐藏。以后把精确时间队列接到第一层执行器并完成验证后再恢复。

## 每日总结状态如何判断

先看数据库里最近成功落库的日期，再单独展示最近失败尝试。失败的补跑不会覆盖已经存在的总结，也不能据此说「从某天起流水线一直失败」。
