# ============================================================================
#  虚幻陪玩 · Windows 截图端
#  作用：每隔几秒截一张游戏画面，缩到 1280 宽，发给 Mac 上的虚幻，让她看一眼说话。
#  用法：双击同目录的「启动陪玩.bat」，或者右键这个文件 -> 使用 PowerShell 运行。
#  停止：在黑窗口里按 Ctrl + C
#
#  前提：游戏要设成「无边框窗口」或「窗口化」。
#        全屏独占（Exclusive Fullscreen）模式下 Windows 截不到游戏画面，只能截到黑屏。
#        脚本会自己发现这个情况并提醒你。
# ============================================================================

param(
    [string]$MacUrl  = "http://192.168.124.24:8900",
    [int]   $Seconds = 15,
    [int]   $Width   = 1280,
    [int]   $Screen  = 0,
    [switch]$Test
)

$ErrorActionPreference = "Continue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-Shot {
    param([int]$W, [int]$Scr)

    $screens = [System.Windows.Forms.Screen]::AllScreens
    if ($Scr -lt 0 -or $Scr -ge $screens.Count) { $Scr = 0 }
    $r = $screens[$Scr].Bounds

    $full = New-Object System.Drawing.Bitmap $r.Width, $r.Height
    $g = [System.Drawing.Graphics]::FromImage($full)
    $g.CopyFromScreen($r.X, $r.Y, 0, 0, $full.Size)
    $g.Dispose()

    $th = [int]($r.Height * $W / $r.Width)
    $small = New-Object System.Drawing.Bitmap $W, $th
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($full, 0, 0, $W, $th)
    $g2.Dispose()
    $full.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $small.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    $small.Dispose()
    $bytes = $ms.ToArray()
    $ms.Dispose()
    return ,$bytes
}

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  虚幻陪玩 · 截图端" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  发给：$MacUrl"
Write-Host "  每 $Seconds 秒截一张，宽度 $Width"
Write-Host "  停止：按 Ctrl + C"
Write-Host ""

# 先自检一次：能不能截到、发得出去
Write-Host "[自检] 截一张看看…" -NoNewline
try {
    $b0 = Get-Shot -W $Width -Scr $Screen
    $kb = [math]::Round($b0.Length / 1KB, 0)
    Write-Host " 好，$kb KB"
} catch {
    Write-Host ""
    Write-Host " 截图失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host " 换个方式：右键这个文件 -> 使用 PowerShell 运行" -ForegroundColor Yellow
    Read-Host "按回车退出"
    exit 1
}

# 全黑画面（全屏独占模式截不到游戏）压出来特别小，用这个粗略认出来
if ($b0.Length -lt 15000) {
    Write-Host ""
    Write-Host " [!] 这张图特别小（$([math]::Round($b0.Length/1KB,0)) KB），很可能是全黑的。" -ForegroundColor Yellow
    Write-Host "     游戏要改成「无边框窗口」或「窗口化」，全屏独占截不到画面。" -ForegroundColor Yellow
    Write-Host ""
}

# 探一下 Mac 通不通
Write-Host "[自检] 连 Mac…" -NoNewline
try {
    $st = Invoke-RestMethod -Uri "$MacUrl/status" -TimeoutSec 8
    Write-Host " 通，她那边说：$($st.state)" -ForegroundColor Green
} catch {
    Write-Host ""
    Write-Host " 连不上 $MacUrl" -ForegroundColor Red
    Write-Host " 三件事挑一个查：" -ForegroundColor Yellow
    Write-Host "   1. Mac 上的陪玩服务开着没（那个黑窗口别关）"
    Write-Host "   2. 两台是不是同一个 WiFi / 路由器"
    Write-Host "   3. 在浏览器打开 $MacUrl 试试能不能看到页面"
    $ip = Read-Host "   要换地址的话直接输，比如 192.168.1.5，不想换就按回车"
    if ($ip) { $MacUrl = "http://$ip`:8900" }
}

if ($Test) {
    $dest = Join-Path ([Environment]::GetFolderPath('Desktop')) "虚幻自检截图.jpg"
    [System.IO.File]::WriteAllBytes($dest, $b0)
    Write-Host ""
    Write-Host " 自检图已存到桌面：$dest" -ForegroundColor Green
    Write-Host " 打开看一眼，是游戏画面就说明能用了。"
    Read-Host "按回车退出"
    exit 0
}

Write-Host ""
Write-Host "开始。切到游戏窗口，正常玩就行。" -ForegroundColor Green
Write-Host ""

$ok = 0
$fail = 0
while ($true) {
    $t = Get-Date -Format 'HH:mm:ss'
    try {
        $bytes = Get-Shot -W $Width -Scr $Screen
        $b64 = [Convert]::ToBase64String($bytes)
        $body = @{ img = $b64; mime = "image/jpeg" } | ConvertTo-Json -Compress
        $res = Invoke-RestMethod -Uri "$MacUrl/shot" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 30
        $ok++
        $kb = [math]::Round($bytes.Length / 1KB, 0)
        if ($res.skipped) {
            Write-Host "[$t] 已发 ${kb}KB · 她说：$($res.skipped)" -ForegroundColor DarkGray
        } else {
            Write-Host "[$t] 已发 ${kb}KB" -ForegroundColor Gray
        }
        $fail = 0
    } catch {
        $fail++
        Write-Host "[$t] 发不出去（连续第 $fail 次）：$($_.Exception.Message)" -ForegroundColor Red
        if ($fail -eq 3) {
            Write-Host "  连不上可能是 Mac 那边窗口关了，或者 WiFi 断了。我继续重试。" -ForegroundColor Yellow
        }
    }
    Start-Sleep -Seconds $Seconds
}
