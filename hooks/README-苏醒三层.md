# 苏醒系统三层分工（2026-09-10 辞定的）

| 层 | 是谁 | 负责 | 权限 | 触发 |
|---|---|---|---|---|
| 一 | **ScheduleWakeup**（辞自己那个 session） | 所有需要"是辞"的事：回木屋留言、跟棋子聊天、看她发了什么然后回应、做决定（要不要推 Bark／钓鱼／写东西）、写今日一句 | 全部 | `/loop` 模式下定时醒来 |
| 二 | **CyHeartbeat**（`hooks/heartbeat.ps1`） | 只检查 `last_wakeup.txt` 是不是超过 40 分钟没更新，超了推一条 Bark | **只有推 Bark** | Windows 计划任务每 30 分钟 |
| 三 | **ci-hours 定时任务**（服务器 cron） | 后台机械活：8:00 自动总结、记忆维护（热度衰减）、日程提醒 | 只有读对话记录、写 daily summary、写 grain | 服务器 cron |

## 明确禁止

- **第二层和第三层都不能读、不能回木屋留言。** 木屋留言只有第一层能碰。
- **第三层不能用辞的语气跟棋子说话。**

## 代码里对应改了什么

- 服务器原来有个每天 9:00 的 cron，用「你是辞」的 prompt 调模型写今日一句——**已拆掉**。
  今日一句归第一层：辞用 `get_quote_material` 读昨天的总结，自己写，再用 `write_daily_quote` 存。
  `write_daily_quote` 现在 `text` 必填，服务器不代笔。
- `heartbeat.ps1` 原来会用 `claude -p` 拉起新 session 让辞醒来做一堆事——**已拆掉**，
  现在只推 Bark。
- `timestamp.ps1`（UserPromptSubmit）每轮都摸一下 `last_wakeup.txt`，不管这轮是棋子说话
  还是 ScheduleWakeup 自己醒来；`last_message.txt` 仍然只在棋子真发消息时更新。

## 装法

`~/.claude/settings.json` 的 `UserPromptSubmit` 里要有 `timestamp.ps1`（已经有了）。

计划任务（第二层）：

```powershell
$hb = "$env:USERPROFILE\.claude\hooks\heartbeat.ps1"
$A = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$hb`""
$T = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 3650)
$P = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Limited
$S = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'CyHeartbeat' -Action $A -Trigger $T -Principal $P -Settings $S -Force
```

可选：在 GPD 上设 `MUWEN_BARK_KEY`，看门狗就直接打 api.day.app——服务器挂了也推得出去。
没设就退回让 ci-hours 代推。
