[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$config = Get-Content -LiteralPath "C:\DOK-Harness\acceptance-config.json" -Encoding UTF8 -Raw | ConvertFrom-Json
$source = [string]$config.sourceDirectory
$evidenceDirectory = [string]$config.sandboxEvidence
$statusFile = Join-Path $evidenceDirectory "live-status.json"
$logFile = Join-Path $evidenceDirectory "live.log"

function Save-LiveStatus {
    param([bool]$Ok, [string]$Stage, [string]$Message, [object]$Evidence = $null)
    [ordered]@{
        schemaVersion = 1
        ok = $Ok
        stage = $Stage
        message = $Message
        completedAt = (Get-Date).ToUniversalTime().ToString("o")
        evidence = $Evidence
    } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $statusFile -Encoding UTF8
}

try {
    Set-Location -LiteralPath $source
    "" | Set-Content -LiteralPath $logFile -Encoding UTF8
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\login.ps1 2>&1 | Tee-Object -FilePath $logFile -Append | Out-Host
    Read-Host "Complete Douyin login yourself, then press Enter to run one-real-item acceptance"
    $raw = powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\accept-one.ps1 2>&1 | Tee-Object -FilePath $logFile -Append | Out-String
    if ($LASTEXITCODE -ne 0) { throw "accept-one.ps1 failed" }
    $evidence = $raw | ConvertFrom-Json
    if (-not $evidence.ok) { throw "accept-one.ps1 did not report ok=true" }
    Save-LiveStatus -Ok $true -Stage "written" -Message "Clean Windows live acceptance passed; scheduling was not installed." -Evidence $evidence
}
catch {
    $safeMessage = ([string]$_.Exception.Message) -replace 'https?://\S+', '[redacted-url]'
    Save-LiveStatus -Ok $false -Stage "live" -Message $safeMessage
    exit 1
}
