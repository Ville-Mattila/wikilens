# Builds the Chrome Web Store (or Firefox AMO) upload ZIP with only the runtime files.
param(
    [ValidateSet("chrome", "firefox")]
    [string]$Target = "chrome"
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version

$staging = Join-Path $env:TEMP "wikilens-package"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory $staging | Out-Null

foreach ($item in "manifest.json", "background.js", "content.js", "options.html", "options.js", "action.html", "action.js") {
    Copy-Item (Join-Path $root $item) $staging
}
Copy-Item (Join-Path $root "icons") (Join-Path $staging "icons") -Recurse

if ($Target -eq "firefox") {
    Copy-Item (Join-Path $root "firefox\manifest.json") (Join-Path $staging "manifest.json") -Force
}

$distDir = Join-Path $root "dist"
New-Item -ItemType Directory -Force $distDir | Out-Null

if ($Target -eq "firefox") {
    $zip = Join-Path $distDir "wikilens-firefox-$version.zip"
} else {
    $zip = Join-Path $distDir "wikilens-$version.zip"
}
if (Test-Path $zip) { Remove-Item $zip -Force }
# Compress-Archive writes backslash entry names on Windows, which violates
# the ZIP spec and is rejected by Mozilla's AMO validator - build the
# archive manually with forward-slash entries instead.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zip, "Create")
try {
    Get-ChildItem $staging -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($staging.Length + 1) -replace "\\", "/"
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, $_.FullName, $rel) | Out-Null
    }
} finally {
    $archive.Dispose()
}
Remove-Item $staging -Recurse -Force

Write-Host "Created $zip"
