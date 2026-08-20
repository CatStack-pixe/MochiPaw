// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { invoke } from '@tauri-apps/api/core'
import { saveNow } from '@tauri-store/pinia'
import { nextTick } from 'vue'

import { logDebug, logError, logInfo } from './diagnostics'
import { withTimeout } from './promise'

const TYPING_STATS_STORE_ID = 'typingStats'

export interface TypingStatsPersistenceAdapter {
  patch: (storeId: string, state: Record<string, unknown>) => Promise<void>
  save: (storeId: string) => Promise<void>
}

export interface TypingStatsState extends Record<string, unknown> {
  dailyCounts: Record<string, number>
  enabled: boolean
}

interface TypingStatsPersistenceOptions {
  adapter?: TypingStatsPersistenceAdapter
  timeoutMs?: number
}

const DEFAULT_PERSISTENCE_TIMEOUT_MS = 10_000

interface TypingStatsMutationTransactionOperations<TSnapshot> {
  apply: () => void | Promise<void>
  persist: () => void | Promise<void>
  restore: (snapshot: TSnapshot) => void | Promise<void>
  snapshot: () => TSnapshot | Promise<TSnapshot>
}

const defaultAdapter: TypingStatsPersistenceAdapter = {
  patch: (storeId, state) => invoke('plugin:pinia|patch', { id: storeId, state }),
  save: storeId => saveNow(storeId),
}

export async function requestTypingStatsStoreSave(
  state: TypingStatsState,
  options: TypingStatsPersistenceOptions = {},
) {
  const adapter = options.adapter ?? defaultAdapter
  const persistentState = {
    dailyCounts: { ...state.dailyCounts },
    enabled: state.enabled,
  }

  const context = {
    storeId: TYPING_STATS_STORE_ID,
    dailyCountDays: Object.keys(persistentState.dailyCounts).length,
    enabled: persistentState.enabled,
    timeoutMs: options.timeoutMs ?? DEFAULT_PERSISTENCE_TIMEOUT_MS,
  }

  logDebug('[typing-stats] persistence scheduled', context)

  try {
    await withTimeout((async () => {
      await nextTick()
      logDebug('[typing-stats] persistence patch started', context)
      await adapter.patch(TYPING_STATS_STORE_ID, persistentState)
      logInfo('[typing-stats] persistence patch completed', context)
      logDebug('[typing-stats] persistence save started', context)
      await adapter.save(TYPING_STATS_STORE_ID)
      logInfo('[typing-stats] persistence save completed', context)
    })(), context.timeoutMs, 'Typing statistics persistence timed out.')
  } catch (error) {
    logError('[typing-stats] persistence failed', { ...context, error })
    throw error
  }
}

export async function executeTypingStatsMutationTransaction<TSnapshot>(
  operations: TypingStatsMutationTransactionOperations<TSnapshot>,
) {
  let snapshot: TSnapshot | undefined
  let snapshotCreated = false

  try {
    snapshot = await operations.snapshot()
    snapshotCreated = true
    await operations.apply()
    await operations.persist()

    return { accepted: true as const }
  } catch (error) {
    if (snapshotCreated) {
      try {
        await operations.restore(snapshot as TSnapshot)
      } catch {
        // Preserve the original mutation or persistence error for the caller.
      }
    }

    return {
      accepted: false as const,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
