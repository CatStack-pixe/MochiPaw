// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { saveAllNow } from '@tauri-store/pinia'
import { nanoid } from 'nanoid'
import { nextTick } from 'vue'

import { requestTypingStatsOperation } from './typingStatsRequest'

let coreStoresWritable = true
let terminalActionInProgress = false

export interface PersistentStoresSaveAdapter {
  flushTypingStats: (pauseId: string) => Promise<void>
  resumeTypingStats: (pauseId: string) => Promise<void>
  saveAll: () => Promise<void>
}

const defaultSaveAdapter: PersistentStoresSaveAdapter = {
  flushTypingStats: pauseId => flushTypingStatsPersistenceNow(pauseId),
  resumeTypingStats: async (pauseId) => {
    const acknowledgement = await requestTypingStatsOperation({ kind: 'resume', pauseId })

    if (!acknowledgement.accepted) {
      throw new Error(acknowledgement.reason ?? 'The main window could not resume typing statistics.')
    }
  },
  saveAll: saveAllNow,
}

export function setCoreStoresPersistenceWritable(writable: boolean) {
  coreStoresWritable = writable
}

export function isCoreStoresPersistenceWritable() {
  return coreStoresWritable
}

export function persistStateWhenWritable<T>(state: T, writable = coreStoresWritable) {
  return writable ? state : undefined
}

export async function flushTypingStatsPersistenceNow(pauseId: string) {
  const acknowledgement = await requestTypingStatsOperation({ kind: 'flush', pauseId })

  if (!acknowledgement.accepted) {
    throw new Error(acknowledgement.reason ?? 'The main window could not flush typing statistics.')
  }
}

export async function saveAllPersistentStoresNow(
  adapter = defaultSaveAdapter,
  pauseId = nanoid(),
) {
  try {
    await adapter.flushTypingStats(pauseId)
    await nextTick()
    await adapter.saveAll()
  } catch (error) {
    try {
      await adapter.resumeTypingStats(pauseId)
    } catch {
      // Preserve the original save error; the main window may already be unavailable.
    }

    throw error
  }
}

export async function runAfterSavingPersistentStores(
  action: () => Promise<void>,
  adapter = defaultSaveAdapter,
) {
  if (terminalActionInProgress) {
    throw new Error('Another application exit or restart is already in progress.')
  }

  terminalActionInProgress = true
  const pauseId = nanoid()

  try {
    await saveAllPersistentStoresNow(adapter, pauseId)

    try {
      await action()
    } catch (error) {
      try {
        await adapter.resumeTypingStats(pauseId)
      } catch {
        // Preserve the process action error; the main window may already be unavailable.
      }

      throw error
    }
  } finally {
    terminalActionInProgress = false
  }
}
