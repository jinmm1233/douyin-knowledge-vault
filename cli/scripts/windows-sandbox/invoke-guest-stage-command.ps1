[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Payload)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

public static class DokGuestStageProcess
{
    public static int Run(string fileName, string arguments, string workingDirectory, string stdoutFile, string stderrFile)
    {
        using (var stdout = new StreamWriter(stdoutFile, false, new UTF8Encoding(false)))
        using (var stderr = new StreamWriter(stderrFile, false, new UTF8Encoding(false)))
        using (var process = new Process())
        {
            stdout.AutoFlush = true;
            stderr.AutoFlush = true;
            process.StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            process.OutputDataReceived += (sender, eventArgs) =>
            {
                if (eventArgs.Data != null) stdout.WriteLine(eventArgs.Data);
            };
            process.ErrorDataReceived += (sender, eventArgs) =>
            {
                if (eventArgs.Data != null) stderr.WriteLine(eventArgs.Data);
            };
            if (!process.Start()) throw new InvalidOperationException("Guest stage command could not start.");
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            // The outer PowerShell stage owns the timeout. This loop observes
            // only the direct process handle. Never call parameterless
            // WaitForExit(), because it also waits for redirected streams held
            // open by detached descendants such as the OpenCLI daemon.
            while (!process.WaitForExit(250)) { }
            int exitCode = process.ExitCode;
            Thread.Sleep(100);
            try { process.CancelOutputRead(); } catch (InvalidOperationException) { }
            try { process.CancelErrorRead(); } catch (InvalidOperationException) { }
            return exitCode;
        }
    }
}
'@

function ConvertTo-ProcessArgument {
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

try {
    $command = Get-Command ([string]$decoded.filePath) -ErrorAction Stop | Select-Object -First 1
    $stdoutFile = [string]$decoded.stdoutFile
    $stderrFile = [string]$decoded.stderrFile
    $arguments = (@($decoded.argumentList) | ForEach-Object { ConvertTo-ProcessArgument ([string]$_) }) -join ' '
    $exitCode = [DokGuestStageProcess]::Run(
        $command.Source,
        $arguments,
        (Get-Location).Path,
        $stdoutFile,
        $stderrFile
    )
    if ($null -eq $exitCode) { $exitCode = 1 }
    exit [int]$exitCode
}
catch {
    ([string]$_.Exception.Message) -replace 'https?://\S+', '[redacted-url]' |
        Set-Content -LiteralPath ([string]$decoded.stderrFile) -Encoding UTF8
    exit 1
}
