// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import {
  executeTypingStatsMutationTransaction,
  requestTypingStatsStoreSave,
} from './typingStatsPersistence'

test('patches the typing stats store before saving it', async () => {
  const calls: string[] = []

  await requestTypingStatsStoreSave({
    dailyCounts: { '2026-08-09': 12 },
    enabled: true,
  }, {
    adapter: {
      patch: async (storeId) => {
        calls.push(`patch:${storeId}`)
      },
      save: async (storeId) => {
        calls.push(`save:${storeId}`)
      },
    },
  })

  assert.deepEqual(calls, ['patch:typingStats', 'save:typingStats'])
})

test('persists only enabled and a shallow copy of daily counts', async () => {
  const dailyCounts = { '2026-08-09': 12 }
  let patchedState: Record<string, unknown> | undefined

  await requestTypingStatsStoreSave({
    dailyCounts,
    enabled: false,
    runtimeOnly: 'discarded',
  }, {
    adapter: {
      patch: async (_storeId, state) => {
        patchedState = state
      },
      save: async () => {},
    },
  })

  assert.deepEqual(patchedState, {
    dailyCounts: { '2026-08-09': 12 },
    enabled: false,
  })
  assert.notEqual(patchedState?.dailyCounts, dailyCounts)

  dailyCounts['2026-08-09'] = 13
  assert.deepEqual(patchedState?.dailyCounts, { '2026-08-09': 12 })
})

test('does not save when the explicit backend patch fails', async () => {
  let saved = false

  await assert.rejects(
    requestTypingStatsStoreSave({ dailyCounts: {}, enabled: true }, {
      adapter: {
        patch: async () => {
          throw new Error('patch failed')
        },
        save: async () => {
          saved = true
        },
      },
    }),
    /patch failed/,
  )
  assert.equal(saved, false)
})

test('times out when the typing stats backend never completes', async () => {
  await assert.rejects(
    requestTypingStatsStoreSave({ dailyCounts: {}, enabled: true }, {
      timeoutMs: 5,
      adapter: {
        patch: () => new Promise<void>(() => {}),
        save: async () => {},
      },
    }),
    /Typing statistics persistence timed out/,
  )
})

test('restores the snapshot when persistence fails after a mutation', async () => {
  const order: string[] = []
  let state: { dailyCounts: Record<string, number>, enabled: boolean } = {
    dailyCounts: { '2026-08-09': 12 },
    enabled: true,
  }

  const result = await executeTypingStatsMutationTransaction({
    snapshot: () => {
      order.push('snapshot')
      return { dailyCounts: { ...state.dailyCounts }, enabled: state.enabled }
    },
    apply: () => {
      order.push('apply')
      state.dailyCounts = {}
    },
    persist: () => {
      order.push('persist')
      throw new Error('disk full')
    },
    restore: (snapshot) => {
      order.push('restore')
      state = snapshot
    },
  })

  assert.deepEqual(order, ['snapshot', 'apply', 'persist', 'restore'])
  assert.deepEqual(state, { dailyCounts: { '2026-08-09': 12 }, enabled: true })
  assert.deepEqual(result, { accepted: false, reason: 'disk full' })
})
