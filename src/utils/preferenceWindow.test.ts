import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import type { PreferenceCloseAdapter } from './preferenceWindow'

import {
  acquirePreferenceCloseBlock,
  flushPreferenceStores,
  isPreferenceCloseBlocked,
  PreferenceCloseCoordinator,
  withPreferenceCloseBlock,
} from './preferenceWindow'

function closeAdapter(overrides: Partial<PreferenceCloseAdapter> = {}) {
  const calls: string[] = []
  const coordinator = new PreferenceCloseCoordinator({
    ready: () => true,
    blocked: () => false,
    begin: async () => {
      calls.push('begin')
      return 7
    },
    hide: async () => {
      calls.push('hide')
    },
    flush: async () => {
      calls.push('flush')
    },
    complete: async (revision) => {
      calls.push(`complete:${revision}`)
    },
    restore: async () => {
      calls.push('restore')
    },
    onError: () => {
      calls.push('error')
    },
    ...overrides,
  })
  return { coordinator, calls }
}

test('defers an early close until hydration has finished', async () => {
  let ready = false
  const { coordinator, calls } = closeAdapter({ ready: () => ready })
  await coordinator.request()
  assert.equal(coordinator.pending, true)
  assert.deepEqual(calls, [])

  ready = true
  await coordinator.request()
  assert.deepEqual(calls, ['begin', 'hide', 'flush', 'complete:7'])
  assert.equal(coordinator.pending, false)
})

test('retains and restores the settings webview when persistence fails', async () => {
  const { coordinator, calls } = closeAdapter({
    flush: async () => {
      throw new Error('disk full')
    },
  })
  await coordinator.request()
  assert.deepEqual(calls, ['begin', 'hide', 'error', 'restore'])
})

test('coalesces concurrent closes and preserves the captured open revision', async () => {
  let release!: () => void
  const flushed = new Promise<void>((resolve) => {
    release = resolve
  })
  const { coordinator, calls } = closeAdapter({ flush: () => flushed })
  const first = coordinator.request()
  const second = coordinator.request()
  assert.equal(first, second)
  release()
  await first
  assert.deepEqual(calls, ['begin', 'hide', 'complete:7'])
})

test('keeps the window active while a protected operation is running', async () => {
  const { coordinator, calls } = closeAdapter({ blocked: () => true })
  await coordinator.request()
  assert.deepEqual(calls, [])
})

test('waits for pending frontend synchronization before saving the backend', async () => {
  let release!: () => void
  const pendingPatch = new Promise<void>((resolve) => {
    release = resolve
  })
  let saved = false
  const result = flushPreferenceStores({
    flush: () => pendingPatch,
    save: async () => {
      saved = true
    },
  })
  await Promise.resolve()
  assert.equal(saved, false)
  release()
  await result
  assert.equal(saved, true)
})

test('a failed frontend patch prevents saving a stale backend snapshot', async () => {
  let saved = false
  await assert.rejects(flushPreferenceStores({
    flush: async () => {
      throw new Error('IPC unavailable')
    },
    save: async () => {
      saved = true
    },
  }), /IPC unavailable/)
  assert.equal(saved, false)
})

test('overlapping operation guards release independently, including failures', async () => {
  const release = acquirePreferenceCloseBlock()
  try {
    await assert.rejects(withPreferenceCloseBlock(async () => {
      assert.equal(isPreferenceCloseBlocked(), true)
      throw new Error('import failed')
    }), /import failed/)
    assert.equal(isPreferenceCloseBlocked(), true)
  } finally {
    release()
  }
  assert.equal(isPreferenceCloseBlocked(), false)
})
