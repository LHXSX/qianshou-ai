# 千手节点 · Windows 一键安装引导
# iwr https://qianshousuanli.com/downloads/latest/install.ps1 -useb | iex
$Origin = if ($env:QIANSHOU_ORIGIN) { $env:QIANSHOU_ORIGIN } else { "https://qianshousuanli.com" }
Write-Host ""
Write-Host "  ⚡ 千手节点 · Windows 安装" -ForegroundColor Cyan
Write-Host "  ────────────────────────────"
try {
  $manifest = Invoke-RestMethod "$Origin/downloads/latest/release.json"
  $prod = $manifest.products | Where-Object { $_.id -eq "qianshou-standard" } | Select-Object -First 1
  $dl = $prod.downloads | Where-Object { $_.platform -eq "windows-x64" -and $_.available -ne $false } | Select-Object -First 1
  if (-not $dl) { throw "Windows 安装包尚未发布" }
  $url = $dl.url -replace "https://dl.qianshousuanli.com/releases/", "$Origin/api/v8/oss/asset-mirror/releases/"
  Write-Host "  📌 版本: v$($prod.version)"
  Write-Host "  ⬇  打开下载: $url"
  Start-Process $url
} catch {
  Write-Host "  ❌ $($_.Exception.Message)"
  Write-Host "  请打开 $Origin/download.html 手动下载"
}
Write-Host ""
