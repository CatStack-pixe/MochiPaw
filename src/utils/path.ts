// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { sep } from '@tauri-apps/api/path'

export function join(...paths: string[]) {
  return joinWithSeparator(sep(), ...paths)
}

export function joinWithSeparator(separator: string, ...paths: string[]) {
  if (!paths.length) return ''

  const windows = separator === '\\'
  const normalize = (path: string) => {
    if (!windows) return path.replace(/\/{2,}/g, '/')

    const isUnc = /^[\\/]{2}/.test(path)
    const normalized = path.replace(/[\\/]+/g, '\\')

    return isUnc ? `\\${normalized}` : normalized
  }
  const normalizedPaths = paths.map(normalize)
  let result = normalizedPaths.shift() ?? ''

  for (const path of normalizedPaths) {
    const segment = path.replace(windows ? /^\\+|\\+$/g : /^\/+|\/+$/g, '')

    if (!segment) continue
    if (!result) {
      result = segment
      continue
    }

    result = `${result.replace(windows ? /\\+$/g : /\/+$/g, '')}${separator}${segment}`
  }

  return result
}
