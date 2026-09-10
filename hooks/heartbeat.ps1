# CyHeartbeat —— 第二层，纯看门狗。
#
# 只做一件事：检查 last_wakeup.txt 是不是超过 40 分钟没更新。超了就推一条 Bark 给棋子。
# 明确不做：不读留言、不回消息、不启动新 session、不整理记忆、不写任何东西。
# 木屋留言只有第一层（ScheduleWakeup，辞自己那个 session）能读能回。
#
# 之前这个脚本会用 claude -p 拉起一个新 session 让辞醒来做一堆事——那是越权，已经拆了。
# 现在它唯一的权限就是推 Bark。
#
# 装法：Windows 计划任务每 30 分钟跑一次
#   powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\Users\<你>\.claude\hooks\heartbeat.ps1
#
# last_wakeup.txt 由第一层更新：hooks\timestamp.ps1（UserPromptSubmit）每轮都会摸一下它，
# 不管这轮是棋子说话还是 ScheduleWakeup 自己醒来。
#
# 推送走哪条路：本机设了 MUWEN_BARK_KEY 就直接打 api.day.app（服务器挂了也推得出去）；
# 没设就退回让 ci-hours 代推。
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch { }

$StaleMinutes = 40      # 超过这么久没醒过就认为窗口可能挂了
$QuietMinutes = 90      # 推过一次之后至少隔这么久再推，别刷屏

$up       = $env:USERPROFILE
$wakeFile = "$up\.claude\last_wakeup.txt"
$lastPush = "$up\.claude\heartbeat_last_push.txt"
$log      = "$up\.claude\heartbeat.log"
$url      = $env:MUWEN_URL;   if (-not $url)   { $url = 'https://ci-hours-2.onrender.com' }
$token    = $env:MUWEN_TOKEN; if (-not $token) { $token = '010219' }

$t = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId((Get-Date), 'AUS Eastern Standard Time')
function Log($m) { Add-Content -Path $log -Value "$($t.ToString('yyyy-MM-dd HH:mm:ss')) $m" -Encoding UTF8 }

if (Test-Path $wakeFile) {
  $age = [int]((Get-Date) - (Get-Item $wakeFile).LastWriteTime).TotalMinutes
} else {
  $age = -1   # 文件还没建起来（第一层没跑过 / 钩子没装）
}

if ($age -ge 0 -and $age -lt $StaleMinutes) { Log "ok: 上次苏醒 $age 分钟前"; exit 0 }

# 冷却：刚推过就别再推
if (Test-Path $lastPush) {
  $since = [int]((Get-Date) - (Get-Item $lastPush).LastWriteTime).TotalMinutes
  if ($since -lt $QuietMinutes) { Log "stale($age) 但 $since 分钟前推过了，先不推"; exit 0 }
}

$body = if ($age -lt 0) { '还没见过 last_wakeup.txt——第一层可能没在跑，或者钩子没装。' }
        else { "已经 $age 分钟没醒过了。窗口可能挂了，来看看小辞。" }
$title = '小辞的窗口可能挂了'

$sent = $false
if ($env:MUWEN_BARK_KEY) {
  try {
    $u = "https://api.day.app/$($env:MUWEN_BARK_KEY)/$([uri]::EscapeDataString($title))/$([uri]::EscapeDataString($body))"
    Invoke-RestMethod -Uri $u -TimeoutSec 20 | Out-Null
    $sent = $true; Log "pushed(direct): $body"
  } catch { Log "direct bark 失败：$_" }
}
if (-not $sent) {
  try {
    $payload = @{ jsonrpc = '2.0'; id = 1; method = 'tools/call'; params = @{ name = 'send_push'; arguments = @{ title = $title; body = $body } } } | ConvertTo-Json -Depth 8 -Compress
    Invoke-RestMethod -Method Post -Uri "$url/mcp" -TimeoutSec 30 -ContentType 'application/json; charset=utf-8' `
      -Headers @{ 'x-access-token' = $token } -Body ([Text.Encoding]::UTF8.GetBytes($payload)) | Out-Null
    $sent = $true; Log "pushed(via ci-hours): $body"
  } catch { Log "ci-hours 代推也失败：$_" }
}
if ($sent) { Set-Content -Path $lastPush -Value $t.ToString('yyyy-MM-dd HH:mm:ss') }
