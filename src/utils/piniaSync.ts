// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { PiniaPluginContext } from 'pinia'

import { invoke } from '@tauri-apps/api/core'
import { createPlugin } from '@tauri-store/pinia'
import { nextTick } from 'vue'

import { logError } from './diagnostics'

/** Tracks the existing synchronization calls without taking another state snapshot. */
export class PendingStoreSync {
  private readonly pending = new Set<Promise<void>>()
  private readonly failures = new Map<string, unknown>()
  private readonly revisions = new Map<string, number>()

  track(id: string, operation: Promise<void>) {
    const revision = (this.revisions.get(id) ?? 0) + 1
    this.revisions.set(id, revision)
    const pending = operation.then(() => {
      if (this.revisions.get(id) === revision) this.failures.delete(id)
    }, (error) => {
      if (this.revisions.get(id) === revision) this.failures.set(id, error)
      logError('[persistence] frontend synchronization failed', { storeId: id, error })
    }).finally(() => this.pending.delete(pending))
    this.pending.add(pending)
  }

  async flush(flushWatchers: () => Promise<unknown> = nextTick) {
    do {
      await flushWatchers()
      await Promise.all(this.pending)
      await flushWatchers()
    } while (this.pending.size)
    if (this.failures.size) throw this.failures.values().next().value
  }
}

const preferenceSync = new PendingStoreSync()
const preferenceWritableStores = new Set(['app', 'cat', 'general', 'shortcut', 'model'])

export function createPersistentStorePlugin(trackPreferences: boolean) {
  const plugin = createPlugin({ saveOnChange: true })
  return (context: PiniaPluginContext) => {
    if (!trackPreferences || !preferenceWritableStores.has(context.store.$id)) return plugin(context)

    // These stores use immediate sync and express their persistence filtering
    // in beforeBackendSync (none has filterKeys). Preserve that hook before
    // tracking its IPC promise. Throttled main-owned stores stay on the plugin.
    const options = context.options.tauri ?? {}
    const beforeBackendSync = options.hooks?.beforeBackendSync
    const trackedContext = {
      ...context,
      options: {
        ...context.options,
        tauri: {
          ...options,
          hooks: {
            ...options.hooks,
            beforeBackendSync(state: Record<string, unknown>) {
              const prepared = beforeBackendSync ? beforeBackendSync(state) : state
              if (prepared) {
                preferenceSync.track(context.store.$id, invoke('plugin:pinia|patch', {
                  id: context.store.$id,
                  state: prepared,
                }))
              }
              return undefined
            },
          },
        },
      },
    }
    return plugin(trackedContext)
  }
}

export function flushPreferenceSync() {
  return preferenceSync.flush()
}
