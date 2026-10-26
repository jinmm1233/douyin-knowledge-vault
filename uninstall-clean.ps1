# 完全卸载脚本：删软件 + 删用户配置（API Key、项目路径、定时任务、缓存）
# 注意：不会删你 Obsidian vault 里的笔记（那是你自己的知识库）

$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "=== 抖音知识库 · 完全卸载 ===" -ForegroundColor Cyan

# 1) 停掉正在跑的进程
Get-Process | Where-Object { $_.Name -like "*douyin-knowledge*" -or $_.Name -like "*抖音知识库*" } | Stop-Process -Force
Write-Host "[1/4] 已停止正在运行的进程"

# 2) 删计划任务（每日自动同步）
Unregister-ScheduledTask -TaskName "Douyin Obsidian Knowledge" -Confirm:$false
Write-Host "[2/4] 已删除 Windows 计划任务"

# 3) 删用户配置目录（API Key、项目设置、缓存、日志、锁文件）
$appData = Join-Path $env:APPDATA ".douyin-knowledge-app"
if (Test-Path $appData) {
    Remove-Item $appData -Recurse -Force
    Write-Host "[3/4] 已删除用户配置: $appData"
} else {
    Write-Host "[3/4] 用户配置目录不存在，跳过"
}

# 4) 提示 NSIS 卸载器
Write-Host ""
Write-Host "[4/4] 软件本体卸载" -ForegroundColor Yellow
Write-Host "接下来会启动软件自带的卸载程序，按提示走完即可。"
Write-Host "你的 Obsidian 知识库笔记不会被删除。"
Write-Host ""

$uninstaller = @(
    "$env:LOCALAPPDATA\Programs\douyin-knowledge-app\Uninstall 抖音知识库.exe",
    "$env:ProgramFiles\抖音知识库\Uninstall 抖音知识库.exe",
    "${env:ProgramFiles(x86)}\抖音知识库\Uninstall 抖音知识库.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($uninstaller) {
    Start-Process $uninstaller
    Write-Host "已启动卸载程序。"
} else {
    Write-Host "没找到卸载程序，可能已经卸载过了。"
}

Write-Host ""
Write-Host "完成。" -ForegroundColor Green
