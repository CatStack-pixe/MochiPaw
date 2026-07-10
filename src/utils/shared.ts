// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { castArray } from 'es-toolkit/compat'

export function clearObject<T extends Record<string, unknown>>(targets: T | T[]) {
  for (const target of castArray<T>(targets)) {
    for (const key of Object.keys(target)) {
      delete target[key]
    }
  }
}
