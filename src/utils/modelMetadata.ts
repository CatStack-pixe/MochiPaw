// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { exists, readTextFile } from '@tauri-apps/plugin-fs'
import JSON5 from 'json5'

import type { ModelAuthorProfile, ModelControlledRelease } from '@/stores/model'

import { join } from '@/utils/path'

export interface ModelProofManifest {
  modelName?: string
  packageId?: string
  author?: ModelAuthorProfile
}

async function readJSONManifest<T extends object>(
  directoryPath: string,
  manifestDirectory: string,
  manifestFile: string,
  fallbackOnInvalid?: T,
): Promise<T | null> {
  const manifestPath = join(directoryPath, manifestDirectory, manifestFile)

  if (!await exists(manifestPath)) return null

  try {
    return JSON5.parse(await readTextFile(manifestPath)) as T
  } catch {
    return fallbackOnInvalid ?? null
  }
}

async function readNearestManifest<T extends object>(
  startPath: string,
  manifestDirectory: string,
  manifestFile: string,
  stopPath?: string,
  fallbackOnInvalid?: T,
): Promise<T | null> {
  let currentPath = startPath
  const normalizedStopPath = stopPath ? normalizePath(stopPath) : undefined

  while (currentPath) {
    const manifest = await readJSONManifest<T>(
      currentPath,
      manifestDirectory,
      manifestFile,
      fallbackOnInvalid,
    )

    if (manifest) return manifest

    const normalizedCurrentPath = normalizePath(currentPath)

    if (normalizedStopPath && normalizedCurrentPath === normalizedStopPath) {
      return null
    }

    const parentPath = getParentPath(currentPath)

    if (!parentPath || normalizePath(parentPath) === normalizedCurrentPath) {
      return null
    }

    currentPath = parentPath
  }

  return null
}

export async function readNearestProofManifest(startPath: string, stopPath?: string) {
  return await readNearestManifest<ModelProofManifest>(
    startPath,
    'mochi-proof',
    'manifest.json',
    stopPath,
  )
}

export async function readNearestControlledRelease(startPath: string, stopPath?: string) {
  return await readNearestManifest<ModelControlledRelease>(
    startPath,
    'mochi-control',
    'release.json',
    stopPath,
    {},
  )
}

function getParentPath(path: string) {
  const separator = path.includes('\\') ? '\\' : '/'
  const parts = path.split(/[\\/]/)

  parts.pop()

  return parts.join(separator)
}

function normalizePath(path: string) {
  return path.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}
