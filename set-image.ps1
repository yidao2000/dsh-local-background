<#
.SYNOPSIS
    给 dsh-local-background 插件换背景图。

.DESCRIPTION
    把指定图片缩放后编码成 base64 data URI，写进同目录 client.js 的 CONFIG 区块。
    图片内容直接嵌进 JS，因此不依赖任何外部文件或服务，也不会被跨域策略拦住。

    默认会先把图缩到 2560x1440 以内并重新编码为 JPEG（质量 85），
    因为原图动辄 4~7 MB，base64 后接近 9 MB，会让每次开页都变慢。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\set-image.ps1 -ImagePath "D:\wallpapers\a.jpg"
    powershell -ExecutionPolicy Bypass -File .\set-image.ps1 -ImagePath "D:\wallpapers\a.jpg" -Dim 0.55
    powershell -ExecutionPolicy Bypass -File .\set-image.ps1 -ImagePath "D:\wallpapers\a.jpg" -MaxWidth 3840 -MaxHeight 2160 -Quality 92
    powershell -ExecutionPolicy Bypass -File .\set-image.ps1 -ImagePath "D:\wallpapers\a.png" -NoResize

.NOTES
    换完图需要让 DSH 重新加载：刷新页面，或重启桌面应用。
#>
[CmdletBinding()]
param(
    # 图片的绝对路径。支持 .jpg .jpeg .png .webp .gif .avif .bmp
    [Parameter(Mandatory = $true)]
    [string]$ImagePath,

    # 压暗遮罩浓度 0~1（0=不压暗，1=全黑）。默认 0.35。
    [ValidateRange(0, 1)]
    [double]$Dim = 0.35,

    # 缩放后的最大宽度（默认 2560）
    [int]$MaxWidth = 2560,

    # 缩放后的最大高度（默认 1440）
    [int]$MaxHeight = 1440,

    # 重新编码的 JPEG 质量 1~100（默认 85）
    [ValidateRange(1, 100)]
    [int]$Quality = 85,

    # 主面板不透明度 0~1：越小背景越透（文字越难读）。默认 0.72
    [ValidateRange(0, 1)]
    [double]$Surface = 0.72,

    # 跳过缩放与重编码，直接嵌入原始字节（图很大时会很慢）
    [switch]$NoResize
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$clientFile = Join-Path $here 'client.js'

if (-not (Test-Path -LiteralPath $clientFile)) { throw "找不到 client.js：$clientFile" }
if (-not (Test-Path -LiteralPath $ImagePath)) { throw "找不到图片：$ImagePath" }

$image = Get-Item -LiteralPath $ImagePath
$ext = $image.Extension.ToLowerInvariant()
$supported = @('.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp')
if ($supported -notcontains $ext) {
    throw "不支持的图片格式：$ext（支持 $($supported -join ' ')）"
}

function Format-Size([long]$bytes) {
    if ($bytes -ge 1MB) { return "$([math]::Round($bytes / 1MB, 2)) MB" }
    return "$([math]::Round($bytes / 1KB, 1)) KB"
}

# ---------- 读取 +（可选）缩放重编码 ----------
$srcBytes = [System.IO.File]::ReadAllBytes($image.FullName)
$ms = New-Object System.IO.MemoryStream(, $srcBytes)
$src = [System.Drawing.Image]::FromStream($ms, $true, $true)
$srcW = $src.Width
$srcH = $src.Height

$resultBytes = $null
$mime = $null
$outW = $srcW
$outH = $srcH
$note = '原图直接嵌入（未缩放）'

try {
    if ($NoResize) {
        $resultBytes = $srcBytes
        $mime = switch ($ext) {
            '.jpg' { 'image/jpeg' } '.jpeg' { 'image/jpeg' } '.png' { 'image/png' }
            '.webp' { 'image/webp' } '.gif' { 'image/gif' } '.avif' { 'image/avif' } '.bmp' { 'image/bmp' }
        }
    }
    else {
        $scale = [Math]::Min(1.0, [Math]::Min($MaxWidth / $srcW, $MaxHeight / $srcH))
        $outW = [int][Math]::Round($srcW * $scale)
        $outH = [int][Math]::Round($srcH * $scale)
        if ($outW -lt 1) { $outW = 1 }
        if ($outH -lt 1) { $outH = 1 }

        $bmp = New-Object System.Drawing.Bitmap $outW, $outH
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            # JPEG 不支持透明：先铺白底，避免 PNG 透明区变黑
            $g.Clear([System.Drawing.Color]::White)
            $g.DrawImage($src, 0, 0, $outW, $outH)
        }
        finally { $g.Dispose() }

        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
            Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
        if (-not $codec) { throw '系统里找不到 JPEG 编码器。' }
        $encParams = New-Object System.Drawing.Imaging.EncoderParameters 1
        $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
            [System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)

        $out = New-Object System.IO.MemoryStream
        try {
            $bmp.Save($out, $codec, $encParams)
            $resultBytes = $out.ToArray()
        }
        finally { $out.Dispose(); $bmp.Dispose() }

        $mime = 'image/jpeg'
        if ($scale -lt 1.0) {
            $note = "已缩放到 ${outW}x${outH}（原 ${srcW}x${srcH}），JPEG 质量 $Quality"
        }
        else {
            $note = "尺寸不变（${outW}x${outH}），已重新编码为 JPEG 质量 $Quality"
        }
    }
}
finally {
    $src.Dispose()
    $ms.Dispose()
}

if (-not $resultBytes -or $resultBytes.Length -eq 0) { throw '编码失败，没有得到任何字节。' }

$b64 = [System.Convert]::ToBase64String($resultBytes)
$dataUri = "data:$mime;base64,$b64"

# ---------- 写入 client.js 的 CONFIG 区块 ----------
$text = [System.IO.File]::ReadAllText($clientFile, [System.Text.Encoding]::UTF8)

$imagePattern = "(?m)^(\s*var IMAGE = )'.*?'(;.*)$"
$dimPattern = "(?m)^(\s*var DIM = ).*?(;.*)$"

if ($text -notmatch $imagePattern) { throw "client.js 里找不到 'var IMAGE = ...' 这一行，文件可能被改过。" }
if ($text -notmatch $dimPattern) { throw "client.js 里找不到 'var DIM = ...' 这一行，文件可能被改过。" }

$text = [regex]::Replace($text, $imagePattern, { param($m) $m.Groups[1].Value + "'" + $dataUri + "'" + $m.Groups[2].Value })
$text = [regex]::Replace($text, $dimPattern, { param($m) $m.Groups[1].Value + $Dim + $m.Groups[2].Value })

$surfacePattern = "(?m)^(\s*var SURFACE = ).*?(;.*)$"
if ($text -notmatch $surfacePattern) { throw "client.js 里找不到 'var SURFACE = ...' 这一行。" }
$text = [regex]::Replace($text, $surfacePattern, { param($m) $m.Groups[1].Value + $Surface + $m.Groups[2].Value })

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($clientFile, $text, $utf8NoBom)

$outBytes = (Get-Item -LiteralPath $clientFile).Length
$outMb = $outBytes / 1MB

Write-Host ""
Write-Host "  背景图已写入 client.js" -ForegroundColor Green
Write-Host "    源图片    : $($image.FullName)"
Write-Host "    源尺寸    : ${srcW}x${srcH} / $(Format-Size $image.Length)"
Write-Host "    处理      : $note"
Write-Host "    嵌入大小  : $(Format-Size $resultBytes.Length)  ($mime)"
Write-Host "    压暗浓度  : $Dim"
Write-Host "    client.js : $(Format-Size $outBytes)"
Write-Host ""
if ($outMb -gt 8) {
    Write-Host "  ⚠ client.js 偏大（$(Format-Size $outBytes)），页面加载会变慢。" -ForegroundColor Yellow
    Write-Host "    建议：-MaxWidth 1920 -MaxHeight 1080 -Quality 80" -ForegroundColor Yellow
    Write-Host ""
}
Write-Host "  下一步：刷新 DSH 页面（或重启桌面应用）即可看到新背景。" -ForegroundColor Cyan
Write-Host "  恢复默认渐变：把 client.js 里 var IMAGE 那行换回 linear-gradient(...) 即可。" -ForegroundColor DarkGray
Write-Host ""
