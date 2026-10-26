function Ensure-Winget {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,
        [switch]$SkipSystemPackages
    )

    function Resolve-WingetCommand {
        $command = Get-Command winget.exe -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
        return ""
    }

    function Refresh-WingetPath {
        $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
        $user = [Environment]::GetEnvironmentVariable("Path", "User")
        $env:Path = "$machine;$user"
    }

    function Get-Sha256 {
        param([string]$Path)
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
    }

    function Receive-LockedFile {
        param([string]$Url, [string]$Destination, [string]$ExpectedSha256)
        if ((Test-Path -LiteralPath $Destination) -and (Get-Sha256 -Path $Destination) -eq $ExpectedSha256) { return }
        if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
        $partial = "$Destination.part"
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
            try {
                try {
                    Start-BitsTransfer -Source $Url -Destination $partial -ErrorAction Stop | Out-Null
                }
                catch {
                    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $partial -TimeoutSec 120 | Out-Null
                }
                if ((Get-Sha256 -Path $partial) -ne $ExpectedSha256) { throw "Downloaded WinGet asset hash mismatch." }
                Move-Item -LiteralPath $partial -Destination $Destination
                return
            }
            catch {
                if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
                if ($attempt -eq 3) { throw "Unable to download the fixed WinGet asset after 3 attempts." }
                Start-Sleep -Seconds (5 * $attempt)
            }
        }
    }

    $ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
    $winget = Resolve-WingetCommand
    if ($winget) { return $winget }
    if ($SkipSystemPackages) {
        throw "WinGet is required to install missing system packages. Re-run without -SkipSystemPackages or install Microsoft App Installer manually."
    }

    try {
        if (Get-AppxPackage -Name Microsoft.DesktopAppInstaller -ErrorAction SilentlyContinue) {
            if ($PSCmdlet.ShouldProcess("Microsoft.DesktopAppInstaller", "Register the existing WinGet package for this user")) {
                Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -ErrorAction Stop | Out-Null
                Refresh-WingetPath
                $winget = Resolve-WingetCommand
                if ($winget) { return $winget }
            }
        }
    }
    catch {
        Write-Verbose "Existing App Installer registration did not make WinGet available: $($_.Exception.Message)"
    }

    $lockPath = Join-Path $ProjectRoot "winget-bootstrap.lock.json"
    if (-not (Test-Path -LiteralPath $lockPath)) { throw "WinGet bootstrap lock is missing: $lockPath" }
    $lock = Get-Content -LiteralPath $lockPath -Encoding UTF8 -Raw | ConvertFrom-Json
    if ([int]$lock.schemaVersion -ne 1 -or -not $lock.packageManager.version) { throw "WinGet bootstrap lock is invalid." }

    $version = [string]$lock.packageManager.version
    $toolsRoot = Join-Path $ProjectRoot ".bootstrap-tools\winget\$version"
    $bundlePath = Join-Path $toolsRoot "Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle"
    $dependenciesZip = Join-Path $toolsRoot "DesktopAppInstaller_Dependencies.zip"
    $dependenciesDirectory = Join-Path $toolsRoot "dependencies"

    if ($PSCmdlet.ShouldProcess("Microsoft WinGet $version", "Install fixed signed App Installer assets from the official GitHub Release")) {
        $previousProgressPreference = $ProgressPreference
        try {
            $ProgressPreference = "SilentlyContinue"
            New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
            Receive-LockedFile -Url ([string]$lock.packageManager.msixBundle.url) -Destination $bundlePath -ExpectedSha256 ([string]$lock.packageManager.msixBundle.sha256)
            Receive-LockedFile -Url ([string]$lock.packageManager.dependenciesZip.url) -Destination $dependenciesZip -ExpectedSha256 ([string]$lock.packageManager.dependenciesZip.sha256)

            if (-not (Test-Path -LiteralPath $dependenciesDirectory)) {
                $staging = "$dependenciesDirectory.partial"
                if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
                New-Item -ItemType Directory -Path $staging -Force | Out-Null
                Add-Type -AssemblyName System.IO.Compression.FileSystem
                [IO.Compression.ZipFile]::ExtractToDirectory($dependenciesZip, $staging)
                Move-Item -LiteralPath $staging -Destination $dependenciesDirectory
            }

            $architecture = "x64"
            foreach ($dependency in @($lock.packageManager.dependencies)) {
                $installed = Get-AppxPackage -Name ([string]$dependency.name) -ErrorAction SilentlyContinue |
                    Where-Object { $_.Architecture -in @("X64", "Neutral") } |
                    Sort-Object Version -Descending |
                    Select-Object -First 1
                if (-not $installed -or [version]$installed.Version -lt [version]([string]$dependency.version)) {
                    $fileName = "{0}_{1}_{2}.appx" -f ([string]$dependency.name), ([string]$dependency.version), $architecture
                    $dependencyPath = Join-Path $dependenciesDirectory (Join-Path $architecture $fileName)
                    if (-not (Test-Path -LiteralPath $dependencyPath)) { throw "WinGet dependency is missing from the audited archive: $fileName" }
                    Add-AppxPackage -Path $dependencyPath -ErrorAction Stop | Out-Null
                }
            }
            Add-AppxPackage -Path $bundlePath -ForceApplicationShutdown -ErrorAction Stop | Out-Null
        }
        finally {
            $ProgressPreference = $previousProgressPreference
        }
    }

    Refresh-WingetPath
    $winget = Resolve-WingetCommand
    if (-not $winget) { throw "WinGet bootstrap completed but winget.exe is unavailable." }
    $actualVersion = (& $winget --version).Trim().TrimStart("v")
    if ($actualVersion -ne $version.TrimStart("v")) {
        throw "WinGet version mismatch after bootstrap: expected $version, found $actualVersion. Update the audited lock before continuing."
    }
    return $winget
}
