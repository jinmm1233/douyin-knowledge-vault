param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Destination,
    [int]$TimeoutSeconds = 3600
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Invoke-WebRequest `
    -UseBasicParsing `
    -Uri $Url `
    -OutFile $Destination `
    -TimeoutSec $TimeoutSeconds `
    -ErrorAction Stop | Out-Null
