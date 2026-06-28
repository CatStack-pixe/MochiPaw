import { exists, readTextFile } from '@tauri-apps/plugin-fs'
import JSON5 from 'json5'

import { join } from '@/utils/path'

export interface ControlledRelease {
  packageId?: string
  releaseCode?: string
}

export async function readNearestControlledRelease(startPath: string, stopPath?: string) {
  let currentPath = startPath
  const normalizedStopPath = stopPath ? normalizePath(stopPath) : undefined

  while (currentPath) {
    const release = await readControlledRelease(currentPath)

    if (release) return release

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

async function readControlledRelease(sourcePath: string): Promise<ControlledRelease | null> {
  const releasePath = join(sourcePath, 'mochi-control', 'release.json')

  if (!await exists(releasePath)) return null

  try {
    return JSON5.parse(await readTextFile(releasePath)) as ControlledRelease
  } catch {
    return {}
  }
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
