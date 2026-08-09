// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import {
  readCargoLockVersion,
  readCargoManifestVersion,
  replaceCargoLockVersion,
  replaceCargoManifestVersion,
} from './releaseVersion'

test('updates a Cargo package version when default-run separates name and version', () => {
  const manifest = `[package]
name = "mochi-paw"
default-run = "mochi-paw"
version = "1.1.8"

[lib]
name = "mochi_paw_lib"
`
  const updated = replaceCargoManifestVersion(manifest, 'mochi-paw', '1.1.9')

  assert.equal(readCargoManifestVersion(updated, 'mochi-paw'), '1.1.9')
  assert.match(updated, /default-run = "mochi-paw"/)
  assert.match(updated, /\[lib\]\nname = "mochi_paw_lib"/)
})

test('updates only the matching Cargo.lock package', () => {
  const lock = `version = 4

[[package]]
name = "another-package"
version = "1.1.8"

[[package]]
name = "mochi-paw"
version = "1.1.8"
dependencies = []
`
  const updated = replaceCargoLockVersion(lock, 'mochi-paw', '1.1.9')

  assert.equal(readCargoLockVersion(updated, 'mochi-paw'), '1.1.9')
  assert.match(updated, /name = "another-package"\nversion = "1\.1\.8"/)
})

test('fails instead of silently skipping a missing package', () => {
  assert.throws(
    () => replaceCargoManifestVersion('[package]\nname = "other"\nversion = "1.0.0"\n', 'mochi-paw', '1.1.9'),
    /not mochi-paw/,
  )
  assert.throws(
    () => replaceCargoLockVersion('version = 4\n', 'mochi-paw', '1.1.9'),
    /found 0/,
  )
})
