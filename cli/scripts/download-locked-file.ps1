Set-StrictMode -Version Latest
$script:LockedHttpsChild = Join-Path $PSScriptRoot "download-https-child.ps1"

function Invoke-BoundedHttpsDownload {
    param(
        [string]$Url,
        [string]$Destination,
        [int]$ConnectTimeoutSeconds = 120,
        [int]$ReadTimeoutSeconds = 300,
        [int]$TotalTimeoutSeconds = 3600
    )
    $uri = [Uri]$Url
    if ($uri.Scheme -ne "https") { throw "Locked download URL must use HTTPS." }
    if (-not (Test-Path -LiteralPath $script:LockedHttpsChild)) { throw "Bounded HTTPS child script is missing." }
    $powershell = Join-Path $PSHOME "powershell.exe"
    $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script:LockedHttpsChild`" -Url `"$($uri.AbsoluteUri)`" -Destination `"$Destination`" -TimeoutSeconds $TotalTimeoutSeconds"
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $powershell
    $startInfo.Arguments = $arguments
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Unable to start the bounded HTTPS child process." }
    $process.BeginOutputReadLine()
    $process.BeginErrorReadLine()
    $watchdogStatus = "$Destination.watchdog.json"
    $started = Get-Date
    $lastProgressAt = $started
    [long]$lastBytes = 0
    $receivedBytes = $false
    try {
        while (-not $process.HasExited) {
            $now = Get-Date
            if (Test-Path -LiteralPath $Destination) {
                [long]$bytes = (Get-Item -LiteralPath $Destination).Length
                if ($bytes -gt $lastBytes) {
                    $lastBytes = $bytes
                    $receivedBytes = $true
                    $lastProgressAt = $now
                }
            }
            $idleLimit = if ($receivedBytes) { $ReadTimeoutSeconds } else { $ConnectTimeoutSeconds }
            try {
                [ordered]@{
                    schemaVersion = 1
                    processId = $process.Id
                    elapsedSeconds = [Math]::Round(($now - $started).TotalSeconds, 3)
                    idleSeconds = [Math]::Round(($now - $lastProgressAt).TotalSeconds, 3)
                    idleLimitSeconds = $idleLimit
                    bytes = $lastBytes
                    receivedBytes = $receivedBytes
                    updatedAt = $now.ToUniversalTime().ToString("o")
                } | ConvertTo-Json | Set-Content -LiteralPath $watchdogStatus -Encoding UTF8
            }
            catch { }
            if (($now - $lastProgressAt).TotalSeconds -ge $idleLimit) {
                $stage = if ($receivedBytes) { "progress" } else { "first byte" }
                throw "Locked HTTPS download exceeded the $idleLimit-second $stage timeout."
            }
            if (($now - $started).TotalSeconds -ge $TotalTimeoutSeconds) {
                throw "Locked HTTPS download exceeded the $TotalTimeoutSeconds-second total timeout."
            }
            Start-Sleep -Seconds 1
            $process.Refresh()
        }
        $process.WaitForExit()
        $process.Refresh()
        [int]$exitCode = $process.ExitCode
        if ($exitCode -ne 0) { throw "Locked HTTPS child failed with exit $exitCode." }
    }
    catch {
        if (-not $process.HasExited) {
            try { $process.Kill() }
            catch { throw "Unable to terminate the stalled HTTPS child process." }
            if (-not $process.WaitForExit(10000)) {
                throw "The stalled HTTPS child did not exit within 10 seconds."
            }
        }
        throw
    }
    finally {
        $process.Dispose()
        if (Test-Path -LiteralPath $watchdogStatus) { Remove-Item -LiteralPath $watchdogStatus -Force }
    }
}

function Invoke-BoundedBitsDownload {
    param(
        [string]$Url,
        [string]$Destination,
        [string]$DisplayName,
        [int]$NoProgressTimeoutSeconds = 300,
        [int]$TotalTimeoutSeconds = 3600
    )
    Import-Module BitsTransfer -ErrorAction Stop
    $job = Start-BitsTransfer `
        -Source $Url `
        -Destination $Destination `
        -DisplayName $DisplayName `
        -Description "Locked artifact for Douyin Obsidian Knowledge" `
        -Priority Foreground `
        -Asynchronous `
        -ErrorAction Stop
    $started = Get-Date
    $lastProgressAt = $started
    [long]$lastBytes = -1
    try {
        while ($true) {
            $current = Get-BitsTransfer -ErrorAction SilentlyContinue |
                Where-Object { $_.JobId -eq $job.JobId } |
                Select-Object -First 1
            if (-not $current) { throw "BITS job disappeared before completion." }
            $state = [string]$current.JobState
            if ($state -eq "Transferred") {
                $current | Complete-BitsTransfer -ErrorAction Stop
                return
            }
            if ($state -in @("Error", "Cancelled", "Acknowledged")) {
                throw "BITS entered state ${state}: $($current.ErrorDescription)"
            }
            if ([long]$current.BytesTransferred -ne $lastBytes) {
                $lastBytes = [long]$current.BytesTransferred
                $lastProgressAt = Get-Date
            }
            $now = Get-Date
            if (($now - $lastProgressAt).TotalSeconds -ge $NoProgressTimeoutSeconds) {
                throw "BITS made no progress for $NoProgressTimeoutSeconds seconds."
            }
            if (($now - $started).TotalSeconds -ge $TotalTimeoutSeconds) {
                throw "BITS exceeded the $TotalTimeoutSeconds-second total timeout."
            }
            Start-Sleep -Seconds 1
        }
    }
    catch {
        $remaining = Get-BitsTransfer -ErrorAction SilentlyContinue |
            Where-Object { $_.JobId -eq $job.JobId } |
            Select-Object -First 1
        if ($remaining) { $remaining | Remove-BitsTransfer -Confirm:$false -ErrorAction SilentlyContinue }
        throw
    }
}
