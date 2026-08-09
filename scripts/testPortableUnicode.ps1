# SPDX-FileCopyrightText: 2026 InfinityXCat
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$chinese = -join ([char[]](0x4e2d, 0x6587))
$space = -join ([char[]](0x7a7a, 0x683c))
$model = -join ([char[]](0x6a21, 0x578b))
$texture = -join ([char[]](0x7eb9, 0x7406))
$image = -join ([char[]](0x8d34, 0x56fe))
$extract = -join ([char[]](0x89e3, 0x538b))
$result = -join ([char[]](0x7ed3, 0x679c))
$testRoot = Join-Path $temporaryRoot "Mochi $chinese $space #100%-$([guid]::NewGuid().ToString('N'))"
$testRoot = [IO.Path]::GetFullPath($testRoot)

if (-not $testRoot.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Portable smoke directory is outside the system temporary directory: $testRoot"
}

function Assert-FileBytesEqual([string]$expectedPath, [string]$actualPath) {
  $expected = [IO.File]::ReadAllBytes($expectedPath)
  $actual = [IO.File]::ReadAllBytes($actualPath)

  if ($expected.Length -ne $actual.Length) {
    throw "File length differs: $actualPath"
  }

  for ($index = 0; $index -lt $expected.Length; $index += 1) {
    if ($expected[$index] -ne $actual[$index]) {
      throw "File content differs at byte ${index}: $actualPath"
    }
  }
}

try {
  $scriptDirectory = Join-Path $testRoot 'scripts'
  $tauriDirectory = Join-Path $testRoot 'src-tauri'
  $assetDirectory = Join-Path $tauriDirectory 'assets'
  $modelAssetDirectory = Join-Path $assetDirectory "models\$chinese $model #100%\$texture"
  $cliDirectory = Join-Path $testRoot 'node_modules\@tauri-apps\cli'

  New-Item -ItemType Directory -Path $scriptDirectory, $assetDirectory, $modelAssetDirectory, $cliDirectory -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'package.json') -Destination $testRoot
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'scripts\packagePortable.mjs') -Destination $scriptDirectory
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'src-tauri\tauri.conf.json') -Destination $tauriDirectory
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'src-tauri\assets\tray.png') -Destination $assetDirectory

  $fakeCli = @'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const configIndex = args.indexOf('--config')
const expectedConfigPath = resolve('target', 'portable-tauri.conf.json')
const configPath = configIndex < 0 ? undefined : resolve(args[configIndex + 1])

if (args[0] !== 'build' || args[1] !== '--no-bundle' || configPath !== expectedConfigPath) {
  throw new Error(`Unexpected Tauri arguments: ${JSON.stringify(args)}`)
}

JSON.parse(readFileSync(configPath, 'utf8'))

const releaseDirectory = resolve('target', 'release')
mkdirSync(releaseDirectory, { recursive: true })
writeFileSync(resolve(releaseDirectory, 'mochi-paw.exe'), Buffer.from([0x4d, 0x5a, 0x23, 0x25, 0x00, 0xff]))
'@
  $fakeCliPath = Join-Path $cliDirectory 'tauri.js'
  [IO.File]::WriteAllText($fakeCliPath, $fakeCli, [Text.UTF8Encoding]::new($false))

  $sourceAsset = Join-Path $modelAssetDirectory "$image %.bin"
  [IO.File]::WriteAllBytes($sourceAsset, [byte[]](0x00, 0x01, 0x23, 0x25, 0x7f, 0xff))

  Push-Location $testRoot
  try {
    & node 'scripts\packagePortable.mjs'
    if ($LASTEXITCODE -ne 0) {
      throw "Portable packaging failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }

  $archive = Get-ChildItem -LiteralPath (Join-Path $testRoot 'target\release\bundle\portable') -Filter '*.zip' | Select-Object -First 1
  if (-not $archive) {
    throw 'Portable packaging did not create a ZIP archive.'
  }

  $extractedDirectory = Join-Path $testRoot "$extract $result #100%"
  Expand-Archive -LiteralPath $archive.FullName -DestinationPath $extractedDirectory

  $packagedRoot = Join-Path $extractedDirectory 'MochiPaw'
  $sourceExecutable = Join-Path $testRoot 'target\release\mochi-paw.exe'
  $packagedExecutable = Join-Path $packagedRoot 'MochiPaw.exe'
  $packagedAsset = Join-Path $packagedRoot "assets\models\$chinese $model #100%\$texture\$image %.bin"

  Assert-FileBytesEqual $sourceExecutable $packagedExecutable
  Assert-FileBytesEqual $sourceAsset $packagedAsset
} finally {
  if (Test-Path -LiteralPath $testRoot) {
    $cleanupPath = [IO.Path]::GetFullPath($testRoot)
    if ($cleanupPath -eq $temporaryRoot -or -not $cleanupPath.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove unsafe portable smoke directory: $cleanupPath"
    }

    Remove-Item -LiteralPath $cleanupPath -Recurse -Force
  }
}
