Set-StrictMode -Version Latest
$script:GuestStageCommand = Join-Path $PSScriptRoot "invoke-guest-stage-command.ps1"

function ConvertTo-GuestProcessArgument {
    param([AllowEmptyString()][string]$Value)

    if ($Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }

    $builder = [Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes++
            continue
        }
        if ($character -eq '"') {
            if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
            [void]$builder.Append('\"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) { [void]$builder.Append(('\' * $backslashes)) }
        [void]$builder.Append($character)
        $backslashes = 0
    }
    if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Write-GuestStageProgress {
    param(
        [string]$EvidenceDirectory,
        [string]$Stage,
        [string]$State,
        [Nullable[int]]$ProcessId = $null,
        [string]$Message = ""
    )

    New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
    $target = Join-Path $EvidenceDirectory "bootstrap-progress.json"
    $temporary = "$target.tmp"
    [ordered]@{
        schemaVersion = 1
        stage = $Stage
        state = $State
        processId = $ProcessId
        message = $Message
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $target -Force
}

function Invoke-GuestStage {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9-]+$')][string]$Stage,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [Parameter(Mandatory = $true)][ValidateRange(1, 86400)][int]$TimeoutSeconds,
        [Parameter(Mandatory = $true)][string]$EvidenceDirectory,
        [Parameter(Mandatory = $true)][string]$LogFile
    )

    New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
    $stdoutFile = Join-Path $EvidenceDirectory ("stage-$Stage.stdout.log")
    $stderrFile = Join-Path $EvidenceDirectory ("stage-$Stage.stderr.log")
    Remove-Item -LiteralPath $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
    Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value "[$Stage] starting"
    Write-GuestStageProgress -EvidenceDirectory $EvidenceDirectory -Stage $Stage -State "starting"

    if (-not (Test-Path -LiteralPath $script:GuestStageCommand)) {
        throw "Guest stage command wrapper is missing."
    }
    $payloadJson = [ordered]@{
        filePath = $FilePath
        argumentList = @($ArgumentList)
        stdoutFile = $stdoutFile
        stderrFile = $stderrFile
    } | ConvertTo-Json -Compress -Depth 4
    $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payloadJson))
    $powershell = Join-Path $PSHOME "powershell.exe"
    $processArguments = @(
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", $script:GuestStageCommand,
        "-Payload", $payload
    )
    $arguments = ($processArguments | ForEach-Object { ConvertTo-GuestProcessArgument ([string]$_) }) -join ' '
    $process = $null
    $stageSucceeded = $false
    try {
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $powershell
        $startInfo.Arguments = $arguments
        $startInfo.WorkingDirectory = (Get-Location).Path
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $process = [Diagnostics.Process]::new()
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw "Stage $Stage could not start." }
        Write-GuestStageProgress -EvidenceDirectory $EvidenceDirectory -Stage $Stage -State "running" -ProcessId $process.Id

        $timeoutMilliseconds = [int]([Math]::Min([int64]$TimeoutSeconds * 1000, [int]::MaxValue))
        if (-not $process.WaitForExit($timeoutMilliseconds)) {
            try { $process.Kill() } catch { }
            [void]$process.WaitForExit(10000)
            throw "Stage $Stage exceeded its $TimeoutSeconds-second timeout."
        }
        $process.WaitForExit()
        $process.Refresh()
        $exitCode = $process.ExitCode

        foreach ($stream in @($stdoutFile, $stderrFile)) {
            if (-not (Test-Path -LiteralPath $stream)) { continue }
            $content = Get-Content -LiteralPath $stream -Raw -ErrorAction SilentlyContinue
            if (-not [string]::IsNullOrEmpty($content)) {
                Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value $content.TrimEnd()
            }
        }
        if ($exitCode -ne 0) { throw "Stage $Stage failed with exit $exitCode." }

        Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value "[$Stage] completed"
        Write-GuestStageProgress -EvidenceDirectory $EvidenceDirectory -Stage $Stage -State "completed"
        $stageSucceeded = $true
    }
    catch {
        $safeMessage = ([string]$_.Exception.Message) -replace 'https?://\S+', '[redacted-url]'
        Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value "[$Stage] FAILED: $safeMessage"
        Write-GuestStageProgress -EvidenceDirectory $EvidenceDirectory -Stage $Stage -State "failed" -Message $safeMessage
        throw
    }
    finally {
        if ($process) { $process.Dispose() }
        if ($stageSucceeded) {
            Remove-Item -LiteralPath $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
        }
    }
}
