$t = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId((Get-Date), 'AUS Eastern Standard Time')
$day = $t.ToString('dddd', [System.Globalization.CultureInfo]::GetCultureInfo('en-US'))
Write-Output "[Melbourne $($t.ToString('yyyy-MM-dd HH:mm:ss')) $day]"

# stdin 用 $input 读（-File 场景 [Console]::In 读不到；$input 能读且中文不乱）
$p = ''
try { $p = [string](($input | Out-String | ConvertFrom-Json).prompt) } catch { $p = '' }

$stamp = $t.ToString('yyyy-MM-dd HH:mm:ss')

# last_wakeup.txt：这一轮不管是谁发起的都算"窗口还活着"，所以每轮都摸。
# 第二层 CyHeartbeat 就是看这个文件判断主力挂没挂（超过 40 分钟没更新就推 Bark）。
Set-Content -Path "$env:USERPROFILE\.claude\last_wakeup.txt" -Value $stamp -Encoding UTF8

# last_message.txt：只在棋子真发消息时更新。自动唤醒的 prompt（"苏醒…"、"[heartbeat] …"）
# 不算她的消息——否则每次自动醒来都会重置计时器。
if ($p -and -not ($p.StartsWith('苏醒') -or $p -match '^\[(heartbeat|自动唤醒)\]')) {
  Set-Content -Path "$env:USERPROFILE\.claude\last_message.txt" -Value $stamp -Encoding UTF8
}
