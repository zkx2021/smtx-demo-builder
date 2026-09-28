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
$sourceManifestPath = Join-Path $ProjectRoot 'manifest.json'
$manifestPath = Join-Path $dist 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw 'Build the extension before packaging: dist/manifest.json is missing.'
}
$sourceManifestText = Get-Content -LiteralPath $sourceManifestPath -Raw -Encoding UTF8
$builtManifestText = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8
$sourceManifest = $sourceManifestText | ConvertFrom-Json
$manifest = $builtManifestText | ConvertFrom-Json
if ($sourceManifest.version -ne $package.version) {
  throw "Source manifest version $($sourceManifest.version) does not match package version $($package.version)."
}
if ($manifest.version -ne $package.version) {
  throw "Extension version $($manifest.version) does not match package version $($package.version)."
}
if ($sourceManifestText -cne $builtManifestText) {
  throw 'Built manifest differs from source manifest; rebuild before packaging.'
}

$runtimeNames = @('manifest.json', 'index.html', 'recorder.js', 'sw.js', 'assets')
foreach ($name in $runtimeNames) {
  $entryPath = Join-Path $dist $name
  if (-not (Test-Path -LiteralPath $entryPath)) {
    throw "Required extension file is missing: $name"
  }
  $entry = Get-Item -LiteralPath $entryPath -Force
  if (($name -eq 'assets') -ne $entry.PSIsContainer -or
      ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw "Invalid extension entry: $name"
  }
}
foreach ($entry in (Get-ChildItem -LiteralPath $dist -Force)) {
  if ($entry.Name -notin $runtimeNames) {
    throw "Unexpected file in dist: $($entry.Name)"
  }
}
foreach ($entry in (Get-ChildItem -LiteralPath (Join-Path $dist 'assets') -Force -Recurse)) {
  if ($entry.PSIsContainer -or
      ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
      $entry.Name -notmatch '^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(js|css|svg|png|jpe?g|webp|gif|woff2?|ttf)$') {
    throw "Unexpected file in assets: $($entry.FullName)"
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
"$hash  $archiveName" | Set-Content -LiteralPath (Join-Path $OutputDirectory "SMTX-Demo-Builder-v$($package.version).sha256") -Encoding ascii
Write-Output $archivePath
