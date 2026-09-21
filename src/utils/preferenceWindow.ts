// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { saveAllNow } from '@tauri-store/pinia'

import { flushPreferenceSync } from './piniaSync'

const closeBlocks = new Set<symbol>()
const updateBlock = Symbol('update')

export function setPreferenceCloseBlocked(blocked: boolean) {
  if (blocked) closeBlocks.add(updateBlock)
  else closeBlocks.delete(updateBlock)
}

export function acquirePreferenceCloseBlock() {
  const token = Symbol('preference-operation')
  closeBlocks.add(token)
  return () => {
    closeBlocks.delete(token)
  }
}

export async function withPreferenceCloseBlock<T>(action: () => Promise<T>): Promise<T> {
  const release = acquirePreferenceCloseBlock()
  try {
    return await action()
  } finally {
    release()
  }
}

export function isPreferenceCloseBlocked() {
  return closeBlocks.size > 0
}

export interface PreferenceCloseAdapter {
  ready: () => boolean
  blocked: () => boolean
  begin: () => Promise<number>
  hide: () => Promise<void>
  flush: () => Promise<void>
  complete: (revision: number) => Promise<unknown>
  restore: () => Promise<unknown>
  onError: (error: unknown) => void
}

export class PreferenceCloseCoordinator {
  pending = false
  private closing?: Promise<void>

  constructor(private readonly adapter: PreferenceCloseAdapter) {}

  request(): Promise<void> {
    if (this.closing) return this.closing
    if (!this.adapter.ready()) {
      this.pending = true
      return Promise.resolve()
    }
    if (this.adapter.blocked()) return Promise.resolve()

    this.pending = false
    const closing = this.close().finally(() => {
      if (this.closing === closing) this.closing = undefined
    })
    this.closing = closing
    return closing
  }

  private async close() {
    try {
      const revision = await this.adapter.begin()
      await this.adapter.hide()
      await this.adapter.flush()
      await this.adapter.complete(revision)
    } catch (error) {
      this.adapter.onError(error)
      await this.adapter.restore()
    }
  }
}

export interface PreferencePersistenceAdapter {
  flush: () => Promise<void>
  save: () => Promise<void>
}

const persistenceAdapter: PreferencePersistenceAdapter = {
  flush: flushPreferenceSync,
  save: saveAllNow,
}

/** Await frontend synchronization before saving; leave main-owned timers running. */
export async function flushPreferenceStores(
  adapter = persistenceAdapter,
) {
  await adapter.flush()
  await adapter.save()
}
