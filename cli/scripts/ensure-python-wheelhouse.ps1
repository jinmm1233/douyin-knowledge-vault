Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "download-locked-file.ps1")

function Test-LockedPythonWheel {
    param([string]$Path, [long]$ExpectedSize, [string]$ExpectedSha256)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $file = Get-Item -LiteralPath $Path
    if ($file.Length -ne $ExpectedSize) { return $false }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    return $actual.Equals($ExpectedSha256, [StringComparison]::OrdinalIgnoreCase)
}

function Receive-LockedPythonWheel {
    param(
        [string]$Url,
        [string]$Destination,
        [long]$ExpectedSize,
        [string]$ExpectedSha256
    )
    if (Test-LockedPythonWheel -Path $Destination -ExpectedSize $ExpectedSize -ExpectedSha256 $ExpectedSha256) {
        return
    }
    $partial = "$Destination.part"
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
        try {
            try {
                Invoke-BoundedHttpsDownload -Url $Url -Destination $partial -ConnectTimeoutSeconds 120 -ReadTimeoutSeconds 300 -TotalTimeoutSeconds 3600
            }
            catch {
                if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
                Invoke-BoundedBitsDownload `
                    -Url $Url `
                    -Destination $partial `
                    -DisplayName "DOK wheel $([IO.Path]::GetFileName($Destination))"
            }
            if (-not (Test-LockedPythonWheel -Path $partial -ExpectedSize $ExpectedSize -ExpectedSha256 $ExpectedSha256)) {
                throw "Downloaded wheel failed size or SHA-256 verification."
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

function Ensure-PythonWheelhouse {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([string]$ProjectRoot)
    $lockPath = Join-Path $ProjectRoot "python-wheels.lock.json"
    if (-not (Test-Path -LiteralPath $lockPath)) { throw "Python wheel lock is missing: $lockPath" }
    $lock = Get-Content -LiteralPath $lockPath -Encoding UTF8 -Raw | ConvertFrom-Json
    if ([int]$lock.schemaVersion -ne 1 -or [string]$lock.python -ne "3.12" -or [string]$lock.platform -ne "win_amd64") {
        throw "Unsupported Python wheel lock metadata."
    }
    $files = @($lock.files)
    if ($files.Count -eq 0) { throw "Python wheel lock contains no files." }
    $wheelhouse = Join-Path $ProjectRoot ".bootstrap-tools\wheelhouse"
    New-Item -ItemType Directory -Path $wheelhouse -Force | Out-Null
    $mutex = [Threading.Mutex]::new($false, "Local\DouyinObsidianKnowledgePythonWheelhouse")
    $acquired = $false
    try {
        try {
            $acquired = $mutex.WaitOne([TimeSpan]::FromHours(4))
        }
        catch [Threading.AbandonedMutexException] {
            $acquired = $true
        }
        if (-not $acquired) { throw "Timed out waiting for another Python wheelhouse installation." }
        foreach ($entry in $files) {
            $filename = [string]$entry.filename
            if (-not $filename -or [IO.Path]::GetFileName($filename) -ne $filename -or -not $filename.EndsWith(".whl", [StringComparison]::OrdinalIgnoreCase)) {
                throw "Unsafe wheel filename in python-wheels.lock.json."
            }
            $uri = [Uri]([string]$entry.url)
            if ($uri.Scheme -ne "https" -or -not $uri.Host.Equals("files.pythonhosted.org", [StringComparison]::OrdinalIgnoreCase)) {
                throw "Wheel source must be an HTTPS files.pythonhosted.org URL."
            }
            $sha256 = [string]$entry.sha256
            if ($sha256 -notmatch "^[0-9a-fA-F]{64}$" -or [long]$entry.size -le 0) {
                throw "Invalid wheel size or SHA-256 in python-wheels.lock.json."
            }
            $destination = Join-Path $wheelhouse $filename
            if ($PSCmdlet.ShouldProcess($filename, "Download and verify locked Python wheel")) {
                Receive-LockedPythonWheel `
                    -Url $uri.AbsoluteUri `
                    -Destination $destination `
                    -ExpectedSize ([long]$entry.size) `
                    -ExpectedSha256 $sha256
            }
        }
        return $wheelhouse
    }
    finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
