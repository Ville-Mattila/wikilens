# Builds the Chrome Web Store upload ZIP with only the runtime files.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version

$staging = Join-Path $env:TEMP "wikilens-package"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory $staging | Out-Null

foreach ($item in "manifest.json", "background.js", "content.js", "options.html", "options.js") {
    Copy-Item (Join-Path $root $item) $staging
}
Copy-Item (Join-Path $root "icons") (Join-Path $staging "icons") -Recurse

$distDir = Join-Path $root "dist"
New-Item -ItemType Directory -Force $distDir | Out-Null
$zip = Join-Path $distDir "wikilens-$version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip
Remove-Item $staging -Recurse -Force

Write-Host "Created $zip"
