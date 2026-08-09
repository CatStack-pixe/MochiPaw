// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { name, version } from '../package.json'
import { readCargoLockVersion, readCargoManifestVersion } from './releaseVersion'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tag = process.argv[2]

if (!tag) throw new Error('Usage: checkReleaseVersion.ts <tag>')

const versions = {
  package: version,
  manifest: readCargoManifestVersion(
    readFileSync(resolve(root, 'src-tauri', 'Cargo.toml'), 'utf8'),
    name,
  ),
  lock: readCargoLockVersion(readFileSync(resolve(root, 'Cargo.lock'), 'utf8'), name),
}
const expectedTag = `v${version}`

if (tag !== expectedTag) {
  throw new Error(`Release tag ${tag} does not match package version ${expectedTag}.`)
}

for (const [source, sourceVersion] of Object.entries(versions)) {
  if (sourceVersion !== version) {
    throw new Error(`${source} version ${sourceVersion} does not match package version ${version}.`)
  }
}

console.log(`Release version verified: ${tag}`)
