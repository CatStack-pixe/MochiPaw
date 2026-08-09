// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { saveAllNow } from '@tauri-store/pinia'
import { nextTick } from 'vue'

let coreStoresWritable = true

export function setCoreStoresPersistenceWritable(writable: boolean) {
  coreStoresWritable = writable
}

export function isCoreStoresPersistenceWritable() {
  return coreStoresWritable
}

export function persistStateWhenWritable<T>(state: T, writable = coreStoresWritable) {
  return writable ? state : undefined
}

export async function saveAllPersistentStoresNow() {
  await nextTick()
  await saveAllNow()
}
