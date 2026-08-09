// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { name, version } from '../package.json'
import { replaceCargoLockVersion, replaceCargoManifestVersion } from './releaseVersion'

const __dirname = dirname(fileURLToPath(import.meta.url));

(() => {
  const tomlPath = resolve(__dirname, '..', 'src-tauri', 'Cargo.toml')
  const lockPath = resolve(__dirname, '..', 'Cargo.lock')

  const manifest = replaceCargoManifestVersion(readFileSync(tomlPath, 'utf-8'), name, version)
  const lock = replaceCargoLockVersion(readFileSync(lockPath, 'utf-8'), name, version)

  writeFileSync(tomlPath, manifest)
  writeFileSync(lockPath, lock)
})()
