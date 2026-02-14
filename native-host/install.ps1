# xTap — Windows installer for the native messaging host (PowerShell).
# Usage: .\install.ps1 <chrome-extension-id>

param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

$HostName = "com.xtap.host"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$HostPy = Join-Path $ScriptDir "xtap_host.py"
$BatPath = Join-Path $ScriptDir "xtap_host.bat"
$ManifestPath = Join-Path $ScriptDir "$HostName.json"
$RegKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

# Verify python
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Error "python is required but not found in PATH"
    exit 1
}

# Write manifest (path must point to the .bat wrapper)
$manifest = @{
    name = $HostName
    description = "xTap native messaging host -- writes captured tweets to JSONL"
    path = $BatPath
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 2

Set-Content -Path $ManifestPath -Value $manifest -Encoding UTF8

# Create registry key pointing to manifest
if (-not (Test-Path (Split-Path $RegKey))) {
    New-Item -Path (Split-Path $RegKey) -Force | Out-Null
}
New-Item -Path $RegKey -Force | Out-Null
Set-ItemProperty -Path $RegKey -Name "(Default)" -Value $ManifestPath

Write-Host "Installed native messaging host:"
Write-Host "  Manifest: $ManifestPath"
Write-Host "  Registry: $RegKey"
Write-Host "  Host script: $HostPy"
Write-Host "  Extension ID: $ExtensionId"
Write-Host ""
$outputDir = if ($env:XTAP_OUTPUT_DIR) { $env:XTAP_OUTPUT_DIR } else { Join-Path $HOME "Downloads\xtap" }
Write-Host "Output directory (set XTAP_OUTPUT_DIR to change):"
Write-Host "  $outputDir"
