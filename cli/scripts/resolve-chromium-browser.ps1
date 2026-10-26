function Resolve-ChromiumBrowser {
    $candidates = @(
        [pscustomobject]@{
            Name = "Google Chrome"
            Path = Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"
            ExtensionsUrl = "chrome://extensions"
        },
        [pscustomobject]@{
            Name = "Google Chrome"
            Path = Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"
            ExtensionsUrl = "chrome://extensions"
        },
        [pscustomobject]@{
            Name = "Google Chrome"
            Path = Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"
            ExtensionsUrl = "chrome://extensions"
        },
        [pscustomobject]@{
            Name = "Microsoft Edge"
            Path = Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"
            ExtensionsUrl = "edge://extensions"
        },
        [pscustomobject]@{
            Name = "Microsoft Edge"
            Path = Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"
            ExtensionsUrl = "edge://extensions"
        },
        [pscustomobject]@{
            Name = "Microsoft Edge"
            Path = Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe"
            ExtensionsUrl = "edge://extensions"
        }
    )

    foreach ($candidate in $candidates) {
        if ($candidate.Path -and (Test-Path -LiteralPath $candidate.Path)) {
            return $candidate
        }
    }
    return $null
}
