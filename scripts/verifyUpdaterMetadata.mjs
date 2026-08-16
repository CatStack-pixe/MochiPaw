// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { argv } from 'node:process'
import { fileURLToPath } from 'node:url'

const requiredUpdaterAssets = [
  { key: 'darwin-aarch64-app', extension: '.app.tar.gz' },
  { key: 'darwin-x86_64-app', extension: '.app.tar.gz' },
  { key: 'linux-aarch64-appimage', extension: '.AppImage' },
  { key: 'linux-x86_64-appimage', extension: '.AppImage' },
  { key: 'windows-x86_64-msi', extension: '.msi' },
  { key: 'windows-x86_64-nsis', extension: '.exe' },
]

const fallbackMappings = [
  ['darwin-aarch64', 'darwin-aarch64-app'],
  ['darwin-x86_64', 'darwin-x86_64-app'],
  ['linux-aarch64', 'linux-aarch64-appimage'],
  ['linux-x86_64', 'linux-x86_64-appimage'],
  ['windows-x86_64', 'windows-x86_64-nsis'],
]

function fail(message) {
  throw new Error(`Invalid updater metadata: ${message}`)
}

function assertPlatform(platforms, key) {
  const platform = platforms[key]

  if (!platform || typeof platform !== 'object') {
    fail(`missing platform ${key}`)
  }

  if (typeof platform.signature !== 'string' || !platform.signature.trim()) {
    fail(`platform ${key} has an empty signature`)
  }

  if (typeof platform.url !== 'string') {
    fail(`platform ${key} has no download URL`)
  }

  let url
  try {
    url = new URL(platform.url)
  } catch {
    fail(`platform ${key} has an invalid download URL`)
  }

  if (url.protocol !== 'https:') {
    fail(`platform ${key} download URL is not HTTPS`)
  }

  return platform
}

function assertUploadedAsset(asset, description) {
  if (asset.state !== 'uploaded') {
    fail(`${description} is not in the uploaded state`)
  }

  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
    fail(`${description} has no content`)
  }
}

export function mergeUpdaterMetadata(documents, expectedVersion) {
  if (!Array.isArray(documents) || documents.length === 0) {
    fail('no metadata fragments were provided')
  }

  const merged = {
    ...documents[0],
    platforms: {},
  }

  for (const document of documents) {
    if (!document || typeof document !== 'object' || document.version !== expectedVersion) {
      fail(`every metadata fragment must have version ${expectedVersion}`)
    }

    if (!document.platforms || typeof document.platforms !== 'object') {
      fail('every metadata fragment must contain platforms')
    }

    for (const [key, platform] of Object.entries(document.platforms)) {
      const existing = merged.platforms[key]
      if (existing && (existing.url !== platform.url || existing.signature !== platform.signature)) {
        fail(`metadata fragments disagree on platform ${key}`)
      }
      merged.platforms[key] = platform
    }
  }

  return merged
}

export function verifyUpdaterMetadata(metadata, assets, expectedVersion) {
  if (!metadata || typeof metadata !== 'object') {
    fail('root value must be an object')
  }

  if (metadata.version !== expectedVersion) {
    fail(`expected version ${expectedVersion}, received ${String(metadata.version)}`)
  }

  if (!metadata.platforms || typeof metadata.platforms !== 'object') {
    fail('platforms must be an object')
  }

  if (!Array.isArray(assets)) {
    fail('release assets must be an array')
  }

  const assetsByUrl = new Map()
  const assetsByName = new Map()
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object' || typeof asset.name !== 'string') continue
    assetsByName.set(asset.name, asset)
    if (typeof asset.url === 'string') assetsByUrl.set(asset.url, asset)
    if (typeof asset.browser_download_url === 'string') {
      assetsByUrl.set(asset.browser_download_url, asset)
    }
  }

  for (const { key, extension } of requiredUpdaterAssets) {
    const platform = assertPlatform(metadata.platforms, key)
    const asset = assetsByUrl.get(platform.url)

    if (!asset) {
      fail(`platform ${key} URL does not reference an asset in this release`)
    }

    if (!asset.name.toLowerCase().endsWith(extension.toLowerCase())) {
      fail(`platform ${key} references unexpected asset ${asset.name}`)
    }

    assertUploadedAsset(asset, `platform ${key} asset ${asset.name}`)

    const signatureAsset = assetsByName.get(`${asset.name}.sig`)
    if (!signatureAsset) {
      fail(`platform ${key} has no matching signature asset`)
    }
    assertUploadedAsset(signatureAsset, `platform ${key} signature asset ${signatureAsset.name}`)
  }

  for (const [fallbackKey, installerKey] of fallbackMappings) {
    const fallback = assertPlatform(metadata.platforms, fallbackKey)
    const installer = assertPlatform(metadata.platforms, installerKey)

    if (fallback.url !== installer.url || fallback.signature !== installer.signature) {
      fail(`platform ${fallbackKey} is not a fallback for ${installerKey}`)
    }
  }

  return metadata
}

export function addReleaseNotes(metadata, notes) {
  if (typeof notes !== 'string') {
    fail('release notes must be a string')
  }

  return {
    ...metadata,
    notes,
  }
}

function readMetadataDocuments(path) {
  const paths = []

  function collect(currentPath) {
    const stats = statSync(currentPath)
    if (stats.isFile()) {
      if (basename(currentPath) === 'latest.json') paths.push(currentPath)
      return
    }

    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      collect(resolve(currentPath, entry.name))
    }
  }

  collect(resolve(path))
  paths.sort()
  return paths.map(path => JSON.parse(readFileSync(path, 'utf8')))
}

function run() {
  const [metadataPath, assetsPath, expectedVersion, outputPath, releaseNotesPath] = argv.slice(2)

  if (!metadataPath || !assetsPath || !expectedVersion || !outputPath || !releaseNotesPath) {
    throw new Error('Usage: node scripts/verifyUpdaterMetadata.mjs <metadata> <assets> <version> <output> <release-notes>')
  }

  const documents = readMetadataDocuments(metadataPath)
  const assets = JSON.parse(readFileSync(resolve(assetsPath), 'utf8'))
  const metadata = mergeUpdaterMetadata(documents, expectedVersion)
  const verified = verifyUpdaterMetadata(metadata, assets, expectedVersion)
  const releaseNotes = readFileSync(resolve(releaseNotesPath), 'utf8').trimEnd()
  writeFileSync(resolve(outputPath), `${JSON.stringify(addReleaseNotes(verified, releaseNotes), null, 2)}\n`)
}

if (argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  run()
}
