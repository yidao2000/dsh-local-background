param([string]$Key = 'dsh-local-background:probe')
$dir = Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop\Local Storage\leveldb'
if (-not (Test-Path $dir)) { Write-Host "找不到 leveldb 目录: $dir"; exit 1 }
$needle = [System.Text.Encoding]::UTF8.GetBytes($Key)
$found = $false
Get-ChildItem $dir -File | ForEach-Object {
    try {
        # leveldb 正被 DSH 占用 -> 用 FileShare.ReadWrite 共享读
        $fs = [System.IO.File]::Open($_.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $len = [int]$fs.Length
            $bytes = New-Object byte[] $len
            [void]$fs.Read($bytes, 0, $len)
        } finally { $fs.Dispose() }
    } catch {
        Write-Host "  (跳过 $($_.Name): $($_.Exception.Message))"
        return
    }
    for ($i = 0; $i -le $bytes.Length - $needle.Length; $i++) {
        $ok = $true
        for ($j = 0; $j -lt $needle.Length; $j++) { if ($bytes[$i + $j] -ne $needle[$j]) { $ok = $false; break } }
        if ($ok) {
            $found = $true
            $end = [Math]::Min($bytes.Length - 1, $i + 400)
            $seg = [System.Text.Encoding]::UTF8.GetString($bytes, $i, $end - $i + 1)
            $seg = ($seg -split '[^\x20-\x7E{}":,\.\-]')[0]
            Write-Host "  命中于 $($_.Name) @偏移 $i"
            Write-Host "  内容: $seg"
            break
        }
    }
}
if (-not $found) { Write-Host "  ✗ 没有找到 key '$Key' —— 客户端 bundle 从未执行过" }