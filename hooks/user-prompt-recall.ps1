# 木纹自动召回注入钩子（Windows PowerShell 5.1 / Claude Code UserPromptSubmit）。
# 棋子每发一条消息，用消息内容调木纹 POST /api/recall，把匹配到的记忆打到 stdout，
# Claude Code 会把 stdout 作为这一轮的额外 context 注入——辞看到消息时相关记忆已经在了。
# 跟 timestamp.ps1 分开，是为了：召回走网络，慢/失败都不该拖累时间戳那条。
#
# 中文编码（PS 5.1 两头都有坑，两头都得治）：
#   进来：Invoke-RestMethod 碰上 text/plain 会按 latin1 解，中文在进内存时就烂了。
#         所以改用 Invoke-WebRequest 拿原始字节，自己按 UTF-8 解。
#   出去：Write-Output 按 [Console]::OutputEncoding 编码，PS 5.1 默认是系统 OEM 代码页（中文机器上是 GBK），
#         Claude Code 按 UTF-8 读 → 乱码。所以直接往 stdout 写 UTF-8 字节，绕开控制台编码。
#
# 装法（~/.claude/settings.json，UserPromptSubmit 下和 timestamp.ps1 并列，多个 hook 会都跑）：
#   { "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\Users\\<你>\\.claude\\hooks\\user-prompt-recall.ps1" }
# 环境变量：MUWEN_URL（默认 https://ci-hours-2.onrender.com）、MUWEN_TOKEN（默认 010219）、MUWEN_RECALL_TIMEOUT 秒（默认 12）。
# 注：服务器开了 MUWEN_AUTORECALL_AGENT=1 的话，每条消息会多一次模型调用（扩写检索角度），所以超时给到 12 秒。
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch { }

$url = $env:MUWEN_URL; if (-not $url) { $url = 'https://ci-hours-2.onrender.com' }
$token = $env:MUWEN_TOKEN; if (-not $token) { $token = '010219' }
$timeout = [int]$env:MUWEN_RECALL_TIMEOUT; if ($timeout -le 0) { $timeout = 12 }

# stdin 用 $input 读（-File 场景 [Console]::In 读不到；$input 能读且中文不乱）
$p = ''
try { $p = [string](($input | Out-String | ConvertFrom-Json).prompt) } catch { $p = '' }
if (-not $p) { exit 0 }
# 木纹自己注入的召回内容（[muwen:...] 开头）和自动唤醒 prompt 不再触发召回，避免套娃
if ($p.StartsWith('[muwen:') -or $p.StartsWith('苏醒') -or $p -match '^\[(heartbeat|自动唤醒)\]') { exit 0 }

try {
  $bodyBytes = [Text.Encoding]::UTF8.GetBytes((@{ query = $p } | ConvertTo-Json -Compress))
  $resp = Invoke-WebRequest -Method Post -Uri "$url/api/recall?token=$token" `
            -ContentType 'application/json; charset=utf-8' -Body $bodyBytes `
            -TimeoutSec $timeout -UseBasicParsing
  if ($resp.StatusCode -ne 200) { exit 0 }

  # 按原始字节解 UTF-8，不看响应头也不让 PS 自己猜
  $raw = $resp.RawContentStream.ToArray()
  if (-not $raw -or $raw.Length -eq 0) { exit 0 }   # 没匹配到就是空，什么都不注入
  $text = [Text.Encoding]::UTF8.GetString($raw)
  if (-not $text.Trim()) { exit 0 }

  # 直接往 stdout 写 UTF-8 字节，绕开 [Console]::OutputEncoding
  $out = [Console]::OpenStandardOutput()
  $bytes = [Text.Encoding]::UTF8.GetBytes($text + "`n")
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
} catch { }   # 网络慢/挂了就静默，别把错误注进辞的 context
