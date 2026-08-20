// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { saveAllNow } from '@tauri-store/pinia'
import { nanoid } from 'nanoid'
import { nextTick } from 'vue'

import { logDebug, logError, logInfo, logWarn } from './diagnostics'
import { requestTypingStatsOperation } from './typingStatsRequest'

let coreStoresWritable = true
let terminalActionPromise: Promise<void> | undefined

export interface PersistentStoresSaveAdapter {
  flushTypingStats: (pauseId: string) => Promise<void>
  resumeTypingStats: (pauseId: string) => Promise<void>
  saveAll: () => Promise<void>
}

const defaultSaveAdapter: PersistentStoresSaveAdapter = {
  flushTypingStats: pauseId => flushTypingStatsPersistenceNow(pauseId, 'persistent-store-save'),
  resumeTypingStats: async (pauseId) => {
    const acknowledgement = await requestTypingStatsOperation(
      { kind: 'resume', pauseId },
      { source: 'persistent-store-recovery' },
    )

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

export async function flushTypingStatsPersistenceNow(pauseId: string, source = 'persistent-store-save') {
  const acknowledgement = await requestTypingStatsOperation(
    { kind: 'flush', pauseId },
    { source },
  )

  if (!acknowledgement.accepted) {
    throw new Error(acknowledgement.reason ?? 'The main window could not flush typing statistics.')
  }
}

export async function saveAllPersistentStoresNow(
  adapter = defaultSaveAdapter,
  pauseId = nanoid(),
) {
  logDebug('[persistence] save started', { pauseId })

  try {
    logDebug('[persistence] flushing typing statistics', { pauseId })
    await adapter.flushTypingStats(pauseId)
    logInfo('[persistence] typing statistics flushed', { pauseId })
    await nextTick()
    logDebug('[persistence] saving persistent stores', { pauseId })
    await adapter.saveAll()
    logInfo('[persistence] persistent stores saved', { pauseId })
  } catch (error) {
    logError('[persistence] save failed', { pauseId, error })

    try {
      logWarn('[persistence] attempting typing statistics recovery', { pauseId })
      await adapter.resumeTypingStats(pauseId)
      logInfo('[persistence] typing statistics recovery completed', { pauseId })
    } catch (recoveryError) {
      logError('[persistence] typing statistics recovery failed', { pauseId, error: recoveryError })
    }

    throw error
  }
}

export async function runAfterSavingPersistentStores(
  action: () => Promise<void>,
  adapter = defaultSaveAdapter,
) {
  if (terminalActionPromise) {
    logWarn('[persistence] duplicate terminal action reused', { window: getWindowState() })
    return terminalActionPromise
  }

  const pauseId = nanoid()
  const actionPromise = (async () => {
    logInfo('[persistence] terminal action started', { pauseId })

    await saveAllPersistentStoresNow(adapter, pauseId)

    try {
      logInfo('[persistence] invoking terminal action', { pauseId })
      await action()
      logInfo('[persistence] terminal action completed', { pauseId })
    } catch (error) {
      logError('[persistence] terminal action failed', { pauseId, error })

      try {
        logWarn('[persistence] recovering after terminal action failure', { pauseId })
        await adapter.resumeTypingStats(pauseId)
        logInfo('[persistence] recovery after terminal action failure completed', { pauseId })
      } catch (recoveryError) {
        logError('[persistence] recovery after terminal action failure failed', { pauseId, error: recoveryError })
      }

      throw error
    }
  })()

  terminalActionPromise = actionPromise

  try {
    await actionPromise
  } finally {
    if (terminalActionPromise === actionPromise) terminalActionPromise = undefined
    logDebug('[persistence] terminal action gate released', { pauseId })
  }
}

function getWindowState() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return undefined

  return {
    visibility: document.visibilityState,
    hidden: document.hidden,
    hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : undefined,
  }
}
