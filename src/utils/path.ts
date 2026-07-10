// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { sep } from '@tauri-apps/api/path'

export function join(...paths: string[]) {
  const joinPaths = paths.map((path, index) => {
    if (index === 0) {
      return path.replace(new RegExp(`${sep()}+$`), '')
    }

    return path.replace(new RegExp(`^${sep()}+|${sep()}+$`, 'g'), '')
  })

  return joinPaths.join(sep())
}
