[CmdletBinding()]
param([string]$ConfigPath = "C:\DOK-Harness\acceptance-config.json")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$config = Get-Content -LiteralPath $ConfigPath -Encoding UTF8 -Raw | ConvertFrom-Json
$evidenceDirectory = [string]$config.sandboxEvidence
$sourceDirectory = [string]$config.sourceDirectory
$progressFile = Join-Path $evidenceDirectory "progress.json"
$wheelhouse = Join-Path $sourceDirectory ".bootstrap-tools\wheelhouse"
$runtime = Join-Path $sourceDirectory ".bootstrap-tools\windows-runtime"
$opencliRuntime = Join-Path $sourceDirectory "var\runtime"
$stageFile = Join-Path $evidenceDirectory "bootstrap-progress.json"

$bits = @(Get-BitsTransfer -ErrorAction SilentlyContinue | Select-Object DisplayName, JobState, BytesTotal, BytesTransferred, ErrorDescription)
$processes = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @("powershell.exe", "msiexec.exe", "python.exe", "node.exe") -or $_.Name -match "python|setup|burn"
} | Select-Object Name, ProcessId, ParentProcessId, CreationDate)
$watchdogs = @(Get-ChildItem -LiteralPath $sourceDirectory -Recurse -File -Filter "*.watchdog.json" -ErrorAction SilentlyContinue | ForEach-Object {
    $watchdog = Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json
    [pscustomobject]@{
        schemaVersion = $watchdog.schemaVersion
        processId = $watchdog.processId
        elapsedSeconds = $watchdog.elapsedSeconds
        idleSeconds = $watchdog.idleSeconds
        idleLimitSeconds = $watchdog.idleLimitSeconds
        bytes = $watchdog.bytes
        receivedBytes = $watchdog.receivedBytes
        updatedAt = $watchdog.updatedAt
    }
})
$stage = if (Test-Path -LiteralPath $stageFile) {
    $rawStage = Get-Content -Raw -LiteralPath $stageFile | ConvertFrom-Json
    [pscustomobject]@{
        schemaVersion = $rawStage.schemaVersion
        stage = $rawStage.stage
        state = $rawStage.state
        processId = $rawStage.processId
        updatedAt = $rawStage.updatedAt
    }
}
else { $null }

[ordered]@{
    schemaVersion = 1
    at = (Get-Date).ToUniversalTime().ToString("o")
    stage = $stage
    bits = $bits
    watchdogs = $watchdogs
    wheelFiles = if (Test-Path -LiteralPath $wheelhouse) { @(Get-ChildItem -LiteralPath $wheelhouse -File -Filter "*.whl").Count } else { 0 }
    wheelBytes = if (Test-Path -LiteralPath $wheelhouse) { [long]((Get-ChildItem -LiteralPath $wheelhouse -File -Filter "*.whl" | Measure-Object Length -Sum).Sum) } else { 0 }
    partialFiles = if (Test-Path -LiteralPath $wheelhouse) { @(Get-ChildItem -LiteralPath $wheelhouse -File -Filter "*.part").Count } else { 0 }
    runtimeFiles = if (Test-Path -LiteralPath $runtime) { @(Get-ChildItem -LiteralPath $runtime -File | Select-Object Name, Length, LastWriteTime) } else { @() }
    opencliFiles = if (Test-Path -LiteralPath $opencliRuntime) { @(Get-ChildItem -LiteralPath $opencliRuntime -File | Select-Object Name, Length, LastWriteTime) } else { @() }
    processes = $processes
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $progressFile -Encoding UTF8

