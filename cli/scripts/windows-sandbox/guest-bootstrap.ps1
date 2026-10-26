[CmdletBinding()]
param([string]$ConfigPath = "C:\DOK-Harness\acceptance-config.json")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$config = Get-Content -LiteralPath $ConfigPath -Encoding UTF8 -Raw | ConvertFrom-Json
$evidenceDirectory = [string]$config.sandboxEvidence
$statusFile = Join-Path $evidenceDirectory "bootstrap-status.json"
$logFile = Join-Path $evidenceDirectory "bootstrap.log"
$startedAt = (Get-Date).ToUniversalTime().ToString("o")
$modelBundleSeeded = $false

function Save-Status {
    param([bool]$Ok, [string]$Stage, [string]$Message, [hashtable]$Evidence = @{})
    [ordered]@{
        schemaVersion = 1
        ok = $Ok
        stage = $Stage
        message = $Message
        startedAt = $startedAt
        completedAt = (Get-Date).ToUniversalTime().ToString("o")
        expectedCommit = [string]$config.expectedCommit
        evidence = $Evidence
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusFile -Encoding UTF8
}

function Refresh-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

function Invoke-Logged {
    param([scriptblock]$Action)
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $Action *>&1 | Tee-Object -FilePath $logFile -Append | Out-Host
        $commandExit = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousErrorActionPreference }
    if ($commandExit -ne 0) { throw "Command failed with exit $commandExit" }
}

try {
    "Windows Sandbox bootstrap started at $startedAt" | Set-Content -LiteralPath $logFile -Encoding UTF8
    if ($config.PSObject.Properties.Name -contains "enableProxyAutoDetect" -and [bool]$config.enableProxyAutoDetect) {
        New-ItemProperty `
            -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" `
            -Name AutoDetect `
            -PropertyType DWord `
            -Value 1 `
            -Force | Out-Null
    }
    $source = [string]$config.sourceDirectory
    $sourceMarker = Join-Path $source ".dok-acceptance-source.json"
    $sourceReady = $false
    if (Test-Path -LiteralPath $source) {
        if (-not (Test-Path -LiteralPath $sourceMarker)) {
            throw "Source directory exists without an acceptance marker: $source"
        }
        $marker = Get-Content -LiteralPath $sourceMarker -Encoding UTF8 -Raw | ConvertFrom-Json
        $sourceReady = ([string]$marker.mode -eq [string]$config.mode) -and
            ([string]$marker.expectedCommit).Equals([string]$config.expectedCommit, [StringComparison]::OrdinalIgnoreCase)
        if (-not $sourceReady) { throw "Existing source directory does not match the fixed acceptance snapshot." }
        Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "Reusing fixed acceptance source $($config.expectedCommit)."
    }

    if (-not $sourceReady -and [string]$config.mode -eq "local-snapshot") {
        if (-not (Test-Path -LiteralPath ([string]$config.sourceArchive))) { throw "Mapped source archive is missing." }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory([string]$config.sourceArchive, $source)
    }
    elseif (-not $sourceReady) {
        if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
            Save-Status -Ok $false -Stage "git" -Message "winget is unavailable in this Windows Sandbox image."
            exit 2
        }
        if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
            Invoke-Logged { winget.exe install --id Git.Git --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity }
            Refresh-ProcessPath
        }
        if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { throw "Git is unavailable after installation." }
        Invoke-Logged { git.exe clone --branch ([string]$config.releaseTag) --depth 1 ([string]$config.repositoryUrl) $source }
        $actualCommit = (git.exe -C $source rev-parse HEAD).Trim()
        if (-not $actualCommit.Equals([string]$config.expectedCommit, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Release commit mismatch."
        }
    }
    if (-not $sourceReady) {
        [ordered]@{
            schemaVersion = 1
            mode = [string]$config.mode
            expectedCommit = [string]$config.expectedCommit
        } | ConvertTo-Json | Set-Content -LiteralPath $sourceMarker -Encoding UTF8
    }

    Set-Location -LiteralPath $source
    . .\scripts\windows-sandbox\invoke-guest-stage.ps1
    Invoke-GuestStage -Stage "bootstrap-initial" -FilePath "powershell.exe" -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ".\bootstrap.ps1",
        "-Profile", "simple",
        "-VaultPath", [string]$config.vaultPath,
        "-VaultFolder", [string]$config.vaultFolder,
        "-ScheduleMinutes", [string][int]$config.scheduleMinutes,
        "-NonInteractive"
    ) -TimeoutSeconds 14400 -EvidenceDirectory $evidenceDirectory -LogFile $logFile
    Refresh-ProcessPath
    Invoke-GuestStage -Stage "bootstrap-idempotent" -FilePath "powershell.exe" -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ".\bootstrap.ps1",
        "-NonInteractive", "-SkipSystemPackages"
    ) -TimeoutSeconds 1800 -EvidenceDirectory $evidenceDirectory -LogFile $logFile
    $modelArguments = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ".\scripts\ensure-whisper-model.ps1",
        "-ProjectRoot", $source,
        "-StateDir", (Join-Path $source "var")
    )
    if ($config.PSObject.Properties.Name -contains "modelBundleSandbox" -and [string]$config.modelBundleSandbox) {
        $modelBundle = [string]$config.modelBundleSandbox
        if (-not (Test-Path -LiteralPath $modelBundle -PathType Container)) {
            throw "Mapped Whisper model bundle is missing."
        }
        $modelArguments += @("-BundleDirectory", $modelBundle)
        $modelBundleSeeded = $true
    }
    Invoke-GuestStage -Stage "whisper-model" -FilePath "powershell.exe" -ArgumentList $modelArguments `
        -TimeoutSeconds 7200 -EvidenceDirectory $evidenceDirectory -LogFile $logFile
    Invoke-GuestStage -Stage "browser-bridge" -FilePath "powershell.exe" -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ".\setup-browser-bridge.ps1", "-SkipOpenBrowser"
    ) -TimeoutSeconds 3900 -EvidenceDirectory $evidenceDirectory -LogFile $logFile
    Invoke-GuestStage -Stage "tests" -FilePath "npm.cmd" -ArgumentList @("test") `
        -TimeoutSeconds 900 -EvidenceDirectory $evidenceDirectory -LogFile $logFile
    Invoke-GuestStage -Stage "security-scan" -FilePath "npm.cmd" -ArgumentList @("run", "security-scan") `
        -TimeoutSeconds 300 -EvidenceDirectory $evidenceDirectory -LogFile $logFile
    Invoke-GuestStage -Stage "backup" -FilePath "powershell.exe" -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ".\backup.ps1"
    ) -TimeoutSeconds 1800 -EvidenceDirectory $evidenceDirectory -LogFile $logFile
    Invoke-GuestStage -Stage "uninstall-whatif" -FilePath "powershell.exe" -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ".\uninstall.ps1", "-RemoveRuntime", "-WhatIf"
    ) -TimeoutSeconds 300 -EvidenceDirectory $evidenceDirectory -LogFile $logFile

    $publicConfig = node.exe --no-warnings .\src\cli.mjs configure --show | Out-String | ConvertFrom-Json
    $schedule = node.exe --no-warnings .\src\cli.mjs schedule status | Out-String | ConvertFrom-Json
    $nodeVersion = (node.exe -p "process.versions.node").Trim()
    $pythonVersion = (& .\.venv\Scripts\python.exe -c "import sys; print(sys.version.split()[0])").Trim()
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "SilentlyContinue"
        $whisperVersionOutput = & .\.venv\Scripts\python.exe -c "import faster_whisper; print(faster_whisper.__version__)" 2>$null
        $whisperVersionExit = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousErrorActionPreference }
    if ($whisperVersionExit -ne 0 -or -not $whisperVersionOutput) {
        throw "faster-whisper could not be imported in the clean Sandbox runtime."
    }
    $whisperVersion = ([string]$whisperVersionOutput).Trim()
    . .\scripts\resolve-chromium-browser.ps1
    $browser = Resolve-ChromiumBrowser
    if (-not $browser) { throw "A supported Chromium browser disappeared after bootstrap." }

    $continueCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\DOK-Harness\guest-live-acceptance.ps1"
    $continueCommand | Set-Content -LiteralPath (Join-Path $evidenceDirectory "CONTINUE_AFTER_EXTENSION.txt") -Encoding UTF8
    Save-Status -Ok $true -Stage "ready-for-extension" -Message "Bootstrap-only acceptance passed. User action is required to load the extension and sign in." -Evidence @{
        node = $nodeVersion
        python = $pythonVersion
        fasterWhisper = $whisperVersion
        vaultRoot = [string]$publicConfig.vault.root
        inbox = [string]$publicConfig.vault.inbox
        scheduleInstalled = [bool]$schedule.installed
        scheduleOwned = [bool]$schedule.owned
        sourceMode = [string]$config.mode
        chromiumBrowser = [string]$browser.Name
        modelBundleSeeded = $modelBundleSeeded
    }

    Start-Process -FilePath $browser.Path -ArgumentList $browser.ExtensionsUrl
}
catch {
    $safeMessage = [string]$_.Exception.Message
    $safeMessage = $safeMessage -replace 'https?://\S+', '[redacted-url]'
    Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "FAILED: $safeMessage"
    Save-Status -Ok $false -Stage "bootstrap" -Message $safeMessage
    exit 1
}
