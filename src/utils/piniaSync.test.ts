import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'
import { createPinia, defineStore } from 'pinia'
import { createApp, nextTick } from 'vue'

import { createPersistentStorePlugin, flushPreferenceSync, PendingStoreSync } from './piniaSync'

test('closing waits for existing IPC without writing a replacement snapshot', async () => {
  const queue = new PendingStoreSync()
  let complete!: () => void
  let finished = false
  queue.track('cat', new Promise<void>((resolve) => {
    complete = resolve
  }))
  const flush = queue.flush(async () => {}).then(() => {
    finished = true
  })
  await Promise.resolve()
  assert.equal(finished, false)
  complete()
  await flush
  assert.equal(finished, true)
})

test('a patch scheduled by the watcher flush is included before closing', async () => {
  const queue = new PendingStoreSync()
  let pass = 0
  let completed = false
  await queue.flush(async () => {
    if (++pass === 1) {
      queue.track('general', Promise.resolve().then(() => {
        completed = true
      }))
    }
  })
  assert.equal(completed, true)
})

test('failed latest IPC keeps closing blocked until a new local change succeeds', async () => {
  const queue = new PendingStoreSync()
  queue.track('cat', Promise.reject(new Error('IPC failed')))
  await assert.rejects(queue.flush(async () => {}), /IPC failed/)
  await assert.rejects(queue.flush(async () => {}), /IPC failed/)
  queue.track('cat', Promise.resolve())
  await queue.flush(async () => {})
})

test('the plugin preserves model filtering and does not send a second snapshot on close', async () => {
  const requests: Array<{ id: string, state: Record<string, unknown> }> = []
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { crypto: globalThis.crypto },
  })
  mockWindows('preference')
  mockIPC((command, payload) => {
    if (command === 'plugin:pinia|load') return {}
    if (command === 'plugin:pinia|patch') {
      requests.push(payload as { id: string, state: Record<string, unknown> })
    }
    return null
  }, { shouldMockEvents: true })
  try {
    const pinia = createPinia()
    pinia.use(createPersistentStorePlugin(true))
    createApp({}).use(pinia)
    const useModel = defineStore('model', {
      state: () => ({ selected: 'initial', runtimeOnly: 'skip' }),
      tauri: {
        hooks: {
          beforeBackendSync: state => ({ selected: state.selected }),
        },
      },
    })
    const store = useModel(pinia)
    await store.$tauri.start()
    store.selected = 'changed'
    await nextTick()
    await flushPreferenceSync()
    assert.deepEqual(requests, [{ id: 'model', state: { selected: 'changed' } }])
    await flushPreferenceSync()
    assert.equal(requests.length, 1)
    await store.$tauri.stop()
  } finally {
    clearMocks()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
