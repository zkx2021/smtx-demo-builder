param(
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'

if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $ProjectRoot 'output/releases'
}

$package = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$dist = Join-Path $ProjectRoot 'dist'
$manifestPath = Join-Path $dist 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw 'Build the extension before packaging: dist/manifest.json is missing.'
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.version -ne $package.version) {
  throw "Extension version $($manifest.version) does not match package version $($package.version)."
}

$runtimeNames = @('manifest.json', 'index.html', 'recorder.js', 'sw.js', 'assets')
foreach ($name in $runtimeNames) {
  if (-not (Test-Path -LiteralPath (Join-Path $dist $name))) {
    throw "Required extension file is missing: $name"
  }
}
foreach ($entry in (Get-ChildItem -LiteralPath $dist -Force)) {
  if ($entry.Name -notin $runtimeNames) {
    throw "Unexpected file in dist: $($entry.Name)"
  }
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$archiveName = "SMTX-Demo-Builder-v$($package.version).zip"
$archivePath = Join-Path $OutputDirectory $archiveName
$runtimePaths = $runtimeNames | ForEach-Object { Join-Path $dist $_ }
Compress-Archive -LiteralPath $runtimePaths -DestinationPath $archivePath -CompressionLevel Optimal -Force
$archiveStream = [System.IO.File]::OpenRead($archivePath)
try {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = [System.BitConverter]::ToString($sha256.ComputeHash($archiveStream)).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
} finally {
  $archiveStream.Dispose()
}
"$hash  $archiveName" | Set-Content -LiteralPath (Join-Path $OutputDirectory 'SHA256SUMS.txt') -Encoding ascii
Write-Output $archivePath
