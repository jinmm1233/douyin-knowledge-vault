[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$StateDir,
    [string]$BundleDirectory = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "download-locked-file.ps1")

function Test-LockedModelFile {
    param([string]$Path, [long]$ExpectedSize, [string]$ExpectedSha256)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $file = Get-Item -LiteralPath $Path
    if ($file.Length -ne $ExpectedSize) { return $false }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    return $actual.Equals($ExpectedSha256, [StringComparison]::OrdinalIgnoreCase)
}

function Receive-LockedModelFile {
    param(
        [string]$Url,
        [string]$Destination,
        [long]$ExpectedSize,
        [string]$ExpectedSha256
    )
    if (Test-LockedModelFile -Path $Destination -ExpectedSize $ExpectedSize -ExpectedSha256 $ExpectedSha256) {
        return
    }
    $partial = "$Destination.part"
    for ($attempt = 1; $attempt -le 3; $attempt += 1) {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
        try {
            try {
                Invoke-BoundedHttpsDownload `
                    -Url $Url `
                    -Destination $partial `
                    -ConnectTimeoutSeconds 120 `
                    -ReadTimeoutSeconds 300 `
                    -TotalTimeoutSeconds 7200
            }
            catch {
                if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
                Invoke-BoundedBitsDownload `
                    -Url $Url `
                    -Destination $partial `
                    -DisplayName "DOK model $([IO.Path]::GetFileName($Destination))" `
                    -NoProgressTimeoutSeconds 300 `
                    -TotalTimeoutSeconds 7200
            }
            if (-not (Test-LockedModelFile -Path $partial -ExpectedSize $ExpectedSize -ExpectedSha256 $ExpectedSha256)) {
                throw "Downloaded model file failed size or SHA-256 verification."
            }
            Move-Item -LiteralPath $partial -Destination $Destination -Force
            return
        }
        catch {
            if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
            if ($attempt -eq 3) {
                throw "Unable to download and verify $([IO.Path]::GetFileName($Destination)) after 3 attempts: $($_.Exception.Message)"
            }
            Start-Sleep -Seconds ([Math]::Pow(2, $attempt))
        }
    }
}

function Import-LockedModelFile {
    param(
        [string]$Source,
        [string]$Destination,
        [long]$ExpectedSize,
        [string]$ExpectedSha256
    )
    if (Test-LockedModelFile -Path $Destination -ExpectedSize $ExpectedSize -ExpectedSha256 $ExpectedSha256) {
        return
    }
    $partial = "$Destination.part"
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    try {
        Copy-Item -LiteralPath $Source -Destination $partial -Force
        if (-not (Test-LockedModelFile -Path $partial -ExpectedSize $ExpectedSize -ExpectedSha256 $ExpectedSha256)) {
            throw "Copied model file failed size or SHA-256 verification."
        }
        Move-Item -LiteralPath $partial -Destination $Destination -Force
    }
    finally {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    }
}

$lockPath = Join-Path $ProjectRoot "models\faster-whisper-small.lock.json"
if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { throw "Whisper model lock is missing: $lockPath" }
$lock = Get-Content -LiteralPath $lockPath -Encoding UTF8 -Raw | ConvertFrom-Json
$repoId = [string]$lock.repoId
$revision = [string]$lock.revision
if ($repoId -notmatch '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$') { throw "Unsafe model repository ID in lock file." }
if ($revision -notmatch '^[0-9a-fA-F]{40}$') { throw "Model revision must be an immutable 40-character commit." }
$files = @($lock.files.PSObject.Properties)
if ($files.Count -eq 0) { throw "Model lock contains no files." }

$verifiedBundleDirectory = ""
if ($BundleDirectory) {
    $verifiedBundleDirectory = [IO.Path]::GetFullPath($BundleDirectory)
    if (-not (Test-Path -LiteralPath $verifiedBundleDirectory -PathType Container)) {
        throw "Whisper model bundle directory is missing: $verifiedBundleDirectory"
    }
    foreach ($property in $files) {
        $filename = [string]$property.Name
        $entry = $property.Value
        if (-not $filename -or [IO.Path]::GetFileName($filename) -ne $filename) { throw "Unsafe model filename in lock file." }
        $sha256 = [string]$entry.sha256
        $size = [long]$entry.bytes
        if ($sha256 -notmatch '^[0-9a-fA-F]{64}$' -or $size -le 0) { throw "Invalid model size or SHA-256 in lock file." }
        $bundleFile = Join-Path $verifiedBundleDirectory $filename
        if (-not (Test-LockedModelFile -Path $bundleFile -ExpectedSize $size -ExpectedSha256 $sha256)) {
            throw "Whisper model bundle file failed size or SHA-256 verification: $filename"
        }
    }
}

$modelDir = Join-Path ([IO.Path]::GetFullPath($StateDir)) ("models\" + $repoId.Replace('/', '--') + "\" + $revision)
New-Item -ItemType Directory -Path $modelDir -Force | Out-Null
$mutex = [Threading.Mutex]::new($false, "Local\DouyinObsidianKnowledgeWhisperModel")
$acquired = $false
try {
    try { $acquired = $mutex.WaitOne([TimeSpan]::FromHours(6)) }
    catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw "Timed out waiting for another Whisper model download." }

    foreach ($property in $files) {
        $filename = [string]$property.Name
        $entry = $property.Value
        if (-not $filename -or [IO.Path]::GetFileName($filename) -ne $filename) { throw "Unsafe model filename in lock file." }
        $sha256 = [string]$entry.sha256
        $size = [long]$entry.bytes
        if ($sha256 -notmatch '^[0-9a-fA-F]{64}$' -or $size -le 0) { throw "Invalid model size or SHA-256 in lock file." }
        $encodedFilename = [Uri]::EscapeDataString($filename)
        $url = "https://huggingface.co/$repoId/resolve/$revision/$encodedFilename`?download=true"
        $destination = Join-Path $modelDir $filename
        if ($verifiedBundleDirectory) {
            $bundleFile = Join-Path $verifiedBundleDirectory $filename
            Import-LockedModelFile -Source $bundleFile -Destination $destination -ExpectedSize $size -ExpectedSha256 $sha256
        }
        else {
            Receive-LockedModelFile -Url $url -Destination $destination -ExpectedSize $size -ExpectedSha256 $sha256
        }
    }
    Write-Output $modelDir
}
finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
