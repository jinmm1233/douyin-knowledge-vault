. (Join-Path $PSScriptRoot "download-locked-file.ps1")

function Get-WindowsRuntimeLock {
    param([string]$ProjectRoot)
    $lockPath = Join-Path $ProjectRoot "windows-runtime.lock.json"
    if (-not (Test-Path -LiteralPath $lockPath)) { throw "Windows runtime lock is missing: $lockPath" }
    $lock = Get-Content -LiteralPath $lockPath -Encoding UTF8 -Raw | ConvertFrom-Json
    if ([int]$lock.schemaVersion -ne 1 -or -not $lock.node.version -or -not $lock.python.version -or -not $lock.visualCppRuntime.version) {
        throw "Windows runtime lock is invalid."
    }
    return $lock
}

function Receive-LockedWindowsInstaller {
    param(
        [string]$Url,
        [string]$Destination,
        [string]$ExpectedSha256,
        [string]$ExpectedSigner,
        [switch]$PreferWebRequest
    )
    function Test-LockedInstaller {
        if (-not (Test-Path -LiteralPath $Destination)) { return $false }
        $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToUpperInvariant()
        if ($actual -ne $ExpectedSha256) { return $false }
        $signature = Get-AuthenticodeSignature -LiteralPath $Destination
        if ($signature.Status -ne "Valid" -or -not $signature.SignerCertificate) { return $false }
        return $signature.SignerCertificate.Subject -like "*$ExpectedSigner*"
    }

    if (Test-LockedInstaller) { return }
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
    $partial = "$Destination.part"
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
        try {
            try {
                if ($PreferWebRequest) {
                    Invoke-BoundedHttpsDownload -Url $Url -Destination $partial -ConnectTimeoutSeconds 120 -ReadTimeoutSeconds 300 -TotalTimeoutSeconds 3600
                }
                else {
                    Start-BitsTransfer -Source $Url -Destination $partial -Priority Foreground -ErrorAction Stop | Out-Null
                }
            }
            catch {
                if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
                if ($PreferWebRequest) {
                    Start-BitsTransfer -Source $Url -Destination $partial -Priority Foreground -ErrorAction Stop | Out-Null
                }
                else {
                    Invoke-BoundedHttpsDownload -Url $Url -Destination $partial -ConnectTimeoutSeconds 120 -ReadTimeoutSeconds 300 -TotalTimeoutSeconds 3600
                }
            }
            Move-Item -LiteralPath $partial -Destination $Destination
            if (-not (Test-LockedInstaller)) { throw "Installer hash or Authenticode signer mismatch." }
            return
        }
        catch {
            if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
            if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
            if ($attempt -eq 3) { throw "Unable to download and verify the fixed Windows installer after 3 attempts." }
            Start-Sleep -Seconds (5 * $attempt)
        }
    }
}

function Install-LockedNode {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([string]$ProjectRoot, [switch]$SkipSystemPackages)
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($node) {
        $parts = (& $node.Source -p "process.versions.node").Trim().Split(".")
        if ([int]$parts[0] -gt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -ge 13)) { return }
    }
    if ($SkipSystemPackages) { throw "Node.js >=22.13 is required. Re-run without -SkipSystemPackages." }
    $lock = Get-WindowsRuntimeLock -ProjectRoot $ProjectRoot
    $toolsRoot = Join-Path $ProjectRoot ".bootstrap-tools\windows-runtime"
    $installer = Join-Path $toolsRoot ([string]$lock.node.file)
    if ($PSCmdlet.ShouldProcess("Node.js $($lock.node.version)", "Install the fixed official x64 MSI")) {
        New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
        Receive-LockedWindowsInstaller -Url ([string]$lock.node.url) -Destination $installer -ExpectedSha256 ([string]$lock.node.sha256) -ExpectedSigner ([string]$lock.node.expectedSigner)
        $arguments = "/i `"$installer`" /qn /norestart"
        $process = Start-Process -FilePath msiexec.exe -ArgumentList $arguments -PassThru -Wait -WindowStyle Hidden
        if ($process.ExitCode -notin @(0, 3010)) { throw "Node.js installer failed with exit $($process.ExitCode)." }
    }
}

function Install-LockedPython312 {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([string]$ProjectRoot, [switch]$SkipSystemPackages)
    if ($SkipSystemPackages) { throw "Python 3.12 is required. Re-run without -SkipSystemPackages." }
    $lock = Get-WindowsRuntimeLock -ProjectRoot $ProjectRoot
    $toolsRoot = Join-Path $ProjectRoot ".bootstrap-tools\windows-runtime"
    $installer = Join-Path $toolsRoot ([string]$lock.python.file)
    if ($PSCmdlet.ShouldProcess("Python $($lock.python.version)", "Install the fixed official x64 per-user runtime")) {
        New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
        Receive-LockedWindowsInstaller -Url ([string]$lock.python.url) -Destination $installer -ExpectedSha256 ([string]$lock.python.sha256) -ExpectedSigner ([string]$lock.python.expectedSigner) -PreferWebRequest
        $arguments = "/quiet InstallAllUsers=0 PrependPath=1 Include_exe=1 Include_lib=1 Include_pip=1 Include_launcher=0 Include_test=0 Include_doc=0 Include_dev=0 Include_tcltk=0 Include_tools=0 Shortcuts=0"
        $process = Start-Process -FilePath $installer -ArgumentList $arguments -PassThru -Wait -WindowStyle Hidden
        if ($process.ExitCode -notin @(0, 3010)) { throw "Python installer failed with exit $($process.ExitCode)." }
    }
}

function Test-LockedVisualCppRuntime {
    param([string]$MinimumVersion)
    $system32 = Join-Path $env:WINDIR "System32"
    foreach ($name in @("vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "concrt140.dll")) {
        if (-not (Test-Path -LiteralPath (Join-Path $system32 $name))) { return $false }
    }
    $runtimeVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $system32 "vcruntime140.dll")).FileVersion
    if (-not $runtimeVersion) { return $false }
    return [version]$runtimeVersion -ge [version]$MinimumVersion
}

function Install-LockedVisualCppRuntime {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([string]$ProjectRoot, [switch]$SkipSystemPackages)
    $lock = Get-WindowsRuntimeLock -ProjectRoot $ProjectRoot
    if (Test-LockedVisualCppRuntime -MinimumVersion ([string]$lock.visualCppRuntime.version)) { return }
    if ($SkipSystemPackages) {
        throw "Microsoft Visual C++ 2015-2022 x64 Runtime $($lock.visualCppRuntime.version) or newer is required. Re-run without -SkipSystemPackages."
    }
    $toolsRoot = Join-Path $ProjectRoot ".bootstrap-tools\windows-runtime"
    $installer = Join-Path $toolsRoot ([string]$lock.visualCppRuntime.file)
    if ($PSCmdlet.ShouldProcess("Microsoft Visual C++ Runtime $($lock.visualCppRuntime.version)", "Install the fixed official x64 redistributable")) {
        New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
        Receive-LockedWindowsInstaller `
            -Url ([string]$lock.visualCppRuntime.url) `
            -Destination $installer `
            -ExpectedSha256 ([string]$lock.visualCppRuntime.sha256) `
            -ExpectedSigner ([string]$lock.visualCppRuntime.expectedSigner) `
            -PreferWebRequest
        $process = Start-Process -FilePath $installer -ArgumentList "/install /quiet /norestart" -PassThru -Wait -WindowStyle Hidden
        if ($process.ExitCode -notin @(0, 3010)) { throw "Microsoft Visual C++ Runtime installer failed with exit $($process.ExitCode)." }
    }
    if (-not (Test-LockedVisualCppRuntime -MinimumVersion ([string]$lock.visualCppRuntime.version))) {
        throw "Microsoft Visual C++ Runtime installation completed but the required x64 DLLs were not available."
    }
}
