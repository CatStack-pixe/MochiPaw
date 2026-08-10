// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import { describe, it } from 'node:test'

import { mergeUpdaterMetadata, verifyUpdaterMetadata } from './verifyUpdaterMetadata.mjs'

const expectedVersion = '1.2.3'

function createFixture() {
  const updaterAssets = [
    createAsset(1, 'MochiPaw_aarch64.app.tar.gz'),
    createAsset(2, 'MochiPaw_x64.app.tar.gz'),
    createAsset(3, 'MochiPaw_aarch64.AppImage'),
    createAsset(4, 'MochiPaw_amd64.AppImage'),
    createAsset(5, 'MochiPaw_x64_en-US.msi'),
    createAsset(6, 'MochiPaw_x64-setup.exe'),
  ]
  const assets = updaterAssets.flatMap(asset => [
    asset,
    createAsset(asset.id + 100, `${asset.name}.sig`),
  ])
  const entries = {
    'darwin-aarch64-app': createPlatform(updaterAssets[0]),
    'darwin-x86_64-app': createPlatform(updaterAssets[1]),
    'linux-aarch64-appimage': createPlatform(updaterAssets[2]),
    'linux-x86_64-appimage': createPlatform(updaterAssets[3]),
    'windows-x86_64-msi': createPlatform(updaterAssets[4]),
    'windows-x86_64-nsis': createPlatform(updaterAssets[5]),
  }

  return {
    assets,
    metadata: {
      version: expectedVersion,
      notes: '',
      pub_date: '2026-08-10T00:00:00.000Z',
      platforms: {
        ...entries,
        'darwin-aarch64': entries['darwin-aarch64-app'],
        'darwin-x86_64': entries['darwin-x86_64-app'],
        'linux-aarch64': entries['linux-aarch64-appimage'],
        'linux-x86_64': entries['linux-x86_64-appimage'],
        'windows-x86_64': entries['windows-x86_64-nsis'],
      },
    },
  }
}

function createAsset(id, name) {
  return {
    id,
    name,
    size: 128,
    state: 'uploaded',
    url: `https://api.github.com/repos/CatStack-pixe/MochiPaw/releases/assets/${id}`,
    browser_download_url: `https://github.com/CatStack-pixe/MochiPaw/releases/download/v${expectedVersion}/${name}`,
  }
}

function createPlatform(asset) {
  return {
    signature: `signature:${asset.name}`,
    url: asset.browser_download_url,
  }
}

describe('verifyUpdaterMetadata', () => {
  it('accepts complete installer-specific metadata with NSIS fallback', () => {
    const fixture = createFixture()
    assert.equal(
      verifyUpdaterMetadata(fixture.metadata, fixture.assets, expectedVersion),
      fixture.metadata,
    )
  })

  it('rejects a missing target architecture', () => {
    const fixture = createFixture()
    delete fixture.metadata.platforms['linux-aarch64-appimage']
    assert.throws(
      () => verifyUpdaterMetadata(fixture.metadata, fixture.assets, expectedVersion),
      /missing platform linux-aarch64-appimage/,
    )
  })

  it('rejects empty signatures', () => {
    const fixture = createFixture()
    fixture.metadata.platforms['windows-x86_64-msi'].signature = ' '
    assert.throws(
      () => verifyUpdaterMetadata(fixture.metadata, fixture.assets, expectedVersion),
      /windows-x86_64-msi has an empty signature/,
    )
  })

  it('rejects URLs that do not belong to the release', () => {
    const fixture = createFixture()
    fixture.metadata.platforms['darwin-aarch64-app'].url = 'https://example.com/update.app.tar.gz'
    assert.throws(
      () => verifyUpdaterMetadata(fixture.metadata, fixture.assets, expectedVersion),
      /URL does not reference an asset in this release/,
    )
  })

  it('accepts tauri-action GitHub API asset URLs', () => {
    const fixture = createFixture()
    fixture.metadata.platforms['darwin-aarch64-app'].url = fixture.assets[0].url
    assert.doesNotThrow(() => verifyUpdaterMetadata(fixture.metadata, fixture.assets, expectedVersion))
  })

  it('requires the legacy Windows entry to prefer NSIS', () => {
    const fixture = createFixture()
    fixture.metadata.platforms['windows-x86_64'] = fixture.metadata.platforms['windows-x86_64-msi']
    assert.throws(
      () => verifyUpdaterMetadata(fixture.metadata, fixture.assets, expectedVersion),
      /windows-x86_64 is not a fallback for windows-x86_64-nsis/,
    )
  })

  it('rejects release assets that are empty or not uploaded', () => {
    const fixture = createFixture()
    fixture.assets.find(asset => asset.name.endsWith('.msi')).size = 0
    assert.throws(
      () => verifyUpdaterMetadata(fixture.metadata, fixture.assets, expectedVersion),
      /windows-x86_64-msi asset .* has no content/,
    )

    const secondFixture = createFixture()
    secondFixture.assets.find(asset => asset.name.endsWith('.AppImage.sig')).state = 'new'
    assert.throws(
      () => verifyUpdaterMetadata(secondFixture.metadata, secondFixture.assets, expectedVersion),
      /linux-aarch64-appimage signature asset .* is not in the uploaded state/,
    )
  })

  it('merges independent matrix fragments', () => {
    const fixture = createFixture()
    const keys = Object.keys(fixture.metadata.platforms)
    const fragments = keys.map(key => ({
      ...fixture.metadata,
      platforms: { [key]: fixture.metadata.platforms[key] },
    }))

    const merged = mergeUpdaterMetadata(fragments, expectedVersion)
    assert.deepEqual(merged.platforms, fixture.metadata.platforms)
    assert.doesNotThrow(() => verifyUpdaterMetadata(merged, fixture.assets, expectedVersion))
  })

  it('rejects conflicting matrix fragments', () => {
    const fixture = createFixture()
    const conflicting = structuredClone(fixture.metadata)
    conflicting.platforms['linux-x86_64'].signature = 'different'
    assert.throws(
      () => mergeUpdaterMetadata([fixture.metadata, conflicting], expectedVersion),
      /metadata fragments disagree on platform linux-x86_64/,
    )
  })
})
