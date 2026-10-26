[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet("local-snapshot", "release")]
    [string]$Mode = "local-snapshot",
    [string]$RepositoryUrl = "",
    [string]$ReleaseTag = "",
    [ValidatePattern("^$|^[0-9a-fA-F]{40}$")]
    [string]$ExpectedCommit = "",
    [string]$OutputDirectory = "",
    [string]$ModelBundleDirectory = "",
    [switch]$Launch
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$SandboxExe = "C:\Windows\System32\WindowsSandbox.exe"
if (-not (Test-Path -LiteralPath $SandboxExe)) { throw "Windows Sandbox is not installed." }

$modelBundleHost = ""
$modelBundleSandbox = ""
if ($ModelBundleDirectory) {
    if (-not (Test-Path -LiteralPath $ModelBundleDirectory -PathType Container)) {
        throw "Whisper model bundle directory is missing: $ModelBundleDirectory"
    }
    $modelBundleHost = (Resolve-Path -LiteralPath $ModelBundleDirectory).Path
    $modelLockPath = Join-Path $ProjectRoot "models\faster-whisper-small.lock.json"
    if (-not (Test-Path -LiteralPath $modelLockPath -PathType Leaf)) {
        throw "Whisper model lock is missing: $modelLockPath"
    }
    $modelLock = Get-Content -LiteralPath $modelLockPath -Encoding UTF8 -Raw | ConvertFrom-Json
    $modelFiles = @($modelLock.files.PSObject.Properties)
    if ($modelFiles.Count -eq 0) { throw "Whisper model lock contains no files." }
    foreach ($property in $modelFiles) {
        $filename = [string]$property.Name
        $entry = $property.Value
        if (-not $filename -or [IO.Path]::GetFileName($filename) -ne $filename) {
            throw "Unsafe model filename in lock file."
        }
        $bundleFile = Join-Path $modelBundleHost $filename
        if (-not (Test-Path -LiteralPath $bundleFile -PathType Leaf)) {
            throw "Whisper model bundle file is missing: $filename"
        }
        $file = Get-Item -LiteralPath $bundleFile
        if ($file.Length -ne [long]$entry.bytes) {
            throw "Whisper model bundle file size mismatch: $filename"
        }
        $actualHash = (Get-FileHash -LiteralPath $bundleFile -Algorithm SHA256).Hash
        if (-not $actualHash.Equals([string]$entry.sha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Whisper model bundle file SHA-256 mismatch: $filename"
        }
    }
    $modelBundleSandbox = "C:\DOK-ModelBundle"
}

if ($Launch) {
    $runningIds = @()
    $wsbCli = Get-Command wsb.exe -ErrorAction SilentlyContinue
    if ($wsbCli) {
        try {
            $running = (& $wsbCli.Source list --raw | Out-String | ConvertFrom-Json).WindowsSandboxEnvironments
            $runningIds = @($running | ForEach-Object { [string]$_.Id } | Where-Object { $_ })
        }
        catch {
            throw "Could not query existing Windows Sandbox instances: $($_.Exception.Message)"
        }
    }
    elseif (Get-Process -Name WindowsSandboxRemoteSession, WindowsSandboxServer, vmmemWindowsSandbox -ErrorAction SilentlyContinue) {
        $runningIds = @("legacy-process-detected")
    }
    if ($runningIds.Count -gt 0) {
        throw "A Windows Sandbox instance is already running. Close it completely before starting clean-machine acceptance."
    }
}

if (-not $OutputDirectory) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $OutputDirectory = Join-Path $ProjectRoot "var\sandbox-acceptance\$stamp"
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $OutputDirectory.StartsWith($ProjectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDirectory must stay within the project root."
}
if ((Test-Path -LiteralPath $OutputDirectory) -and @(Get-ChildItem -LiteralPath $OutputDirectory -Force).Count -gt 0) {
    throw "OutputDirectory must be new or empty so acceptance evidence cannot mix across runs."
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$harnessDirectory = Join-Path $OutputDirectory "harness"
$evidenceDirectory = Join-Path $OutputDirectory "evidence"
New-Item -ItemType Directory -Path $harnessDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null

$config = [ordered]@{
    schemaVersion = 1
    mode = $Mode
    repositoryUrl = $RepositoryUrl
    releaseTag = $ReleaseTag
    expectedCommit = $ExpectedCommit
    sandboxHarness = "C:\DOK-Harness"
    sandboxEvidence = "C:\DOK-Evidence"
    sourceArchive = ""
    sourceDirectory = "C:\DOK-Source"
    modelBundleSandbox = $modelBundleSandbox
    vaultPath = "C:\DOK-Vault"
    vaultFolder = "Douyin Knowledge"
    scheduleMinutes = 60
    enableProxyAutoDetect = $true
}

if ($Mode -eq "local-snapshot") {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot ".git"))) { throw "Local snapshot mode requires a Git checkout." }
    if (git -C $ProjectRoot status --porcelain) { throw "Local snapshot mode requires a clean worktree." }
    $commit = (git -C $ProjectRoot rev-parse HEAD).Trim()
    if (-not $commit) { throw "Could not resolve the current commit." }
    $archive = Join-Path $harnessDirectory "source.zip"
    if ($PSCmdlet.ShouldProcess($archive, "Create an immutable source snapshot")) {
        & git.exe -C $ProjectRoot archive --format=zip --output=$archive $commit
        if ($LASTEXITCODE -ne 0) { throw "git archive failed (exit $LASTEXITCODE)" }
    }
    $config.expectedCommit = $commit
    $config.sourceArchive = "C:\DOK-Harness\source.zip"
}
else {
    if (-not $RepositoryUrl -or -not $ReleaseTag -or -not $ExpectedCommit) {
        throw "Release mode requires RepositoryUrl, ReleaseTag, and ExpectedCommit."
    }
}

$guestBootstrap = Join-Path $PSScriptRoot "guest-bootstrap.ps1"
$guestContinue = Join-Path $PSScriptRoot "guest-live-acceptance.ps1"
$queryProgress = Join-Path $PSScriptRoot "query-progress.ps1"
Copy-Item -LiteralPath $guestBootstrap -Destination (Join-Path $harnessDirectory "guest-bootstrap.ps1") -Force
Copy-Item -LiteralPath $guestContinue -Destination (Join-Path $harnessDirectory "guest-live-acceptance.ps1") -Force
Copy-Item -LiteralPath $queryProgress -Destination (Join-Path $harnessDirectory "query-progress.ps1") -Force
$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $harnessDirectory "acceptance-config.json") -Encoding UTF8

$wsbPath = Join-Path $OutputDirectory "acceptance.wsb"
$settings = [System.Xml.XmlWriterSettings]::new()
$settings.Indent = $true
$settings.Encoding = [System.Text.UTF8Encoding]::new($false)
$writer = [System.Xml.XmlWriter]::Create($wsbPath, $settings)
try {
    $writer.WriteStartDocument()
    $writer.WriteStartElement("Configuration")
    foreach ($pair in @(
        @{ Name = "VGpu"; Value = "Disable" },
        @{ Name = "Networking"; Value = "Enable" },
        @{ Name = "ClipboardRedirection"; Value = "Disable" },
        @{ Name = "PrinterRedirection"; Value = "Disable" },
        @{ Name = "AudioInput"; Value = "Disable" },
        @{ Name = "VideoInput"; Value = "Disable" },
        @{ Name = "ProtectedClient"; Value = "Disable" },
        @{ Name = "MemoryInMB"; Value = "8192" }
    )) {
        $writer.WriteElementString($pair.Name, $pair.Value)
    }
    $writer.WriteStartElement("MappedFolders")
    $writer.WriteStartElement("MappedFolder")
    $writer.WriteElementString("HostFolder", $harnessDirectory)
    $writer.WriteElementString("SandboxFolder", "C:\DOK-Harness")
    $writer.WriteElementString("ReadOnly", "true")
    $writer.WriteEndElement()
    if ($modelBundleHost) {
        $writer.WriteStartElement("MappedFolder")
        $writer.WriteElementString("HostFolder", $modelBundleHost)
        $writer.WriteElementString("SandboxFolder", "C:\DOK-ModelBundle")
        $writer.WriteElementString("ReadOnly", "true")
        $writer.WriteEndElement()
    }
    $writer.WriteStartElement("MappedFolder")
    $writer.WriteElementString("HostFolder", $evidenceDirectory)
    $writer.WriteElementString("SandboxFolder", "C:\DOK-Evidence")
    $writer.WriteElementString("ReadOnly", "false")
    $writer.WriteEndElement()
    $writer.WriteEndElement()
    $writer.WriteStartElement("LogonCommand")
    $writer.WriteElementString("Command", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\DOK-Harness\guest-bootstrap.ps1")
    $writer.WriteEndElement()
    $writer.WriteEndElement()
    $writer.WriteEndDocument()
}
finally { $writer.Dispose() }

$launched = $false
if ($Launch -and $PSCmdlet.ShouldProcess($wsbPath, "Launch Windows Sandbox acceptance")) {
    Start-Process -FilePath $SandboxExe -ArgumentList @($wsbPath)
    $launched = $true
}

[pscustomobject]@{
    ok = $true
    mode = $Mode
    expectedCommit = [string]$config.expectedCommit
    outputDirectory = $OutputDirectory
    wsb = $wsbPath
    launched = $launched
    harnessDirectory = $harnessDirectory
    evidenceDirectory = $evidenceDirectory
    modelBundleMapped = [bool]$modelBundleHost
    statusFile = Join-Path $evidenceDirectory "bootstrap-status.json"
    liveStatusFile = Join-Path $evidenceDirectory "live-status.json"
    progressFile = Join-Path $evidenceDirectory "progress.json"
} | ConvertTo-Json -Depth 4
