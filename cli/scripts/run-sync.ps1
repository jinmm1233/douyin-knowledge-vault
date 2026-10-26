$ErrorActionPreference = "Stop"
# Decode child-process (node) output as UTF-8; PowerShell 5.1 defaults to ANSI and garbles Chinese titles in the log
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
# Project root: prefer $PSScriptRoot; fallback to fixed path when not injected (scheduler/sandbox)
if ($PSScriptRoot) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
} else {
    $projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$logDirectory = Join-Path $projectRoot "var\logs"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logFile = Join-Path $logDirectory "scheduler.log"
$timestamp = Get-Date -Format o
# Write a START line immediately so every scheduled trigger leaves a trace even on early failure
try {
    Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "$timestamp START run-sync.ps1"
} catch {
    # keep going even if logging itself fails, so a log failure never silently kills the job
}
# Locate node: scheduler env may lack node in PATH; try bundled runtime first (packaged app), fixed install paths, then PATH; require >= 22
$bundledNode = Join-Path (Split-Path -Parent $projectRoot) "node\node.exe"
$nodeCandidates = @(
    $bundledNode,
    (Join-Path $env:ProgramFiles "nodejs\node.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe"),
    (Join-Path $env:APPDATA "npm\node.exe")
)
$nodeCommand = $null
foreach ($c in $nodeCandidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { $nodeCommand = $c; break }
}
if (-not $nodeCommand) {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { $nodeCommand = $cmd.Source }
}
if (-not $nodeCommand) {
    Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "$timestamp FAILED: node.exe not found (no PATH entry, common install paths missing)"
    exit 1
}
$nodeMajor = 0
$verOut = & $nodeCommand --version 2>$null
if ($verOut -match "v(\d+)") { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 22) {
    Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "$timestamp FAILED: node version too old $verOut (need >= 22), path $nodeCommand"
    exit 1
}
# AI 配置：环境变量优先（cli.mjs / ai-diagnose.mjs 都读 DOK_LLM_*）；否则从桌面应用设置读取，
# 保证其他用户只要在软件设置页填过 API Key，定时任务的 AI 提取与失败诊断就能用
if (-not $env:DOK_LLM_API_KEY) {
    $appSettingsFile = Join-Path $HOME ".douyin-knowledge-app\settings.json"
    if (Test-Path -LiteralPath $appSettingsFile) {
        try {
            $as = Get-Content -LiteralPath $appSettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($as.llmApiKey) { $env:DOK_LLM_API_KEY = [string]$as.llmApiKey }
            if ($as.llmBaseUrl) { $env:DOK_LLM_BASE_URL = [string]$as.llmBaseUrl }
            if ($as.llmModel) { $env:DOK_LLM_MODEL = [string]$as.llmModel }
        } catch { }
    }
}
if (-not $env:DOK_LLM_API_KEY) {
    Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "$timestamp WARN: no DOK_LLM_API_KEY (env or app settings); AI extraction/diagnosis will be unavailable"
}
# Skip if another sync is already running (var\sync.lock exists) to avoid fighting manual batches.
# Stale locks (dead pid or older than 6h, same rule as CLI acquireSyncLock) are removed and we continue.
$lockFile = Join-Path $projectRoot "var\sync.lock"
$lockStale = $false
if (Test-Path -LiteralPath $lockFile) {
    try {
        $lkRaw = Get-Content -LiteralPath $lockFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $alive = $false
        try { $null = Get-Process -Id ([int]$lkRaw.pid) -ErrorAction Stop; $alive = $true } catch { $alive = $false }
        $ageHours = 0
        try { $ageHours = ((Get-Date).ToUniversalTime() - [datetime]$lkRaw.startedAt).TotalHours } catch { $ageHours = 0 }
        if (-not $alive -or $ageHours -gt 6) { $lockStale = $true }
    } catch { $lockStale = $true }
}
if ((Test-Path -LiteralPath $lockFile) -and -not $lockStale) {
    # 有效锁（确有同步进程在跑）：更新进度文件为"被跳过"，避免界面误显示旧任务的 100%
    try {
        $progressFile = Join-Path $projectRoot "var\sync-progress.json"
        $progressJson = '{"running":false,"skipped":true,"done":0,"total":0,"percent":0,"updatedAt":"' + (Get-Date -Format o) + '"}'
        [System.IO.File]::WriteAllText($progressFile, $progressJson, (New-Object System.Text.UTF8Encoding $false))
    } catch { }
    Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "$timestamp SKIPPED: another sync is already running (lock exists)"
    exit 0
}
if (Test-Path -LiteralPath $lockFile) {
    Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "$timestamp STALE-LOCK-CLEARED: removed leftover lock (pid dead or >6h old)"
    Remove-Item -LiteralPath $lockFile -Force
}
# 失败自动重试：瞬时错误（网络/node 内部/API 抖动等）等 30 秒重试一次，仍失败才判 FAILED 并走 AI 诊断
$attempt = 1
$errMsg = ""
while ($attempt -le 2) {
try {
    # 0) progress file (desktop "pipeline" page shows live progress of this run)
    # NOTE: overwrite, not append - Add-Content would leave stale lines and break the desktop JSON parse
    $progressFile = Join-Path $projectRoot "var\sync-progress.json"
    $progressJson = '{"running":true,"stage":"collect-ingest","done":0,"total":0,"percent":0,"updatedAt":"' + (Get-Date -Format o) + '"}'
    [System.IO.File]::WriteAllText($progressFile, $progressJson, (New-Object System.Text.UTF8Encoding $false))
    # 1) API collection (no Chrome needed) + idempotent ingest, refreshes play_url
    $ingest = & $nodeCommand --no-warnings (Join-Path $projectRoot "src\cli.mjs") ingest 2>&1
    # 2) startDate (based on discovered_at = first-seen time ~ new-collect time):
    #    set -> digest up to 500/day of backlog with discovered_at >= startDate until caught up;
    #    empty -> strict incremental, only yesterday-new + yesterday-failed.
    $startDate = ""
    $configFile = Join-Path $projectRoot "config.json"
    if (Test-Path -LiteralPath $configFile) {
        try {
            $cfg = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($cfg.startDate) { $startDate = [string]$cfg.startDate }
        } catch { $startDate = "" }
    }
    # 3) Incremental sync, capped at 500 to avoid runaway.
    #    set -> --since-date <startDate> (discovered_at >= startDate, digest backlog by first-seen time);
    #    empty -> --since-date <yesterday> (strict incremental)
    #    --until-date <tomorrow>: discovered_at < tomorrow 00:00, so items collected today are left for tomorrow
    #    --retry-since <3 days ago>: retry failed items from the last 3 days (updated_at >= that date).
    #       Wider window guarantees a failed item still gets its one retry even if a scheduled day was
    #       missed (PC off / script fault). Rule 8b still stops infinite loops: retried-once failures
    #       are marked skipped and never enter the third day. Content/no-substance items are already skipped.
    $today = (Get-Date).ToString("yyyy-MM-dd")
    $yesterday = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd")
    $tomorrow = (Get-Date).AddDays(1).ToString("yyyy-MM-dd")
    $retrySince = (Get-Date).AddDays(-3).ToString("yyyy-MM-dd")
    $syncArgs = @("sync", "--pending", "500", "--retry-since", $retrySince, "--until-date", $tomorrow, "--progress-file", $progressFile)
    if ($startDate) { $syncArgs += @("--since-date", $startDate) }
    else { $syncArgs += @("--since-date", $yesterday) }
    $syncNew = & $nodeCommand --no-warnings (Join-Path $projectRoot "src\cli.mjs") @syncArgs 2>&1
    # 4) Generate daily collection report
    $report = & $nodeCommand --no-warnings (Join-Path $projectRoot "src\cli.mjs") report 2>&1
    Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "$timestamp OK`n--- ingest ---`n$ingest`n--- syncNew($($syncArgs -join ' ')) ---`n$syncNew`n--- report ---`n$report"
    exit 0
  }
  catch {
    $errMsg = $_.Exception.Message
    if ($attempt -lt 2) {
      Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "$timestamp RETRY-1: first attempt failed ($errMsg); retrying in 30s"
      Start-Sleep -Seconds 30
    }
    $attempt += 1
  }
}
Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "$timestamp FAILED $errMsg"
# AI diagnosis: feed failure context to DeepSeek for a short cause/suggestion (never blocks the original flow)
try {
    $ctxFile = Join-Path $projectRoot "var\logs\scheduler-fail-context.txt"
    $ctxLines = @("time: $timestamp", "error: $errMsg", "attempts: 2")
    if ($ingest) { $ctxLines += "--- ingest output ---`n$ingest" }
    if ($syncNew) { $ctxLines += "--- sync output ---`n$syncNew" }
    if ($report) { $ctxLines += "--- report output ---`n$report" }
    [System.IO.File]::WriteAllText($ctxFile, ($ctxLines -join "`n"), (New-Object System.Text.UTF8Encoding $false))
    $diag = & $nodeCommand --no-warnings (Join-Path $projectRoot "scripts\ai-diagnose.mjs") --context $ctxFile 2>&1
    Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "$timestamp AI-DIAGNOSIS: $diag"
} catch {
    Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "$timestamp AI-DIAGNOSIS FAILED $($_.Exception.Message)"
    }
exit 1
