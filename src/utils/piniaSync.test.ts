import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'
import { createPinia, defineStore } from 'pinia'
import { createApp, nextTick, ref, watch } from 'vue'

import { createModelInputState } from './modelInputState'
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

for (const trackPreferences of [false, true]) {
  test(`input stays reactive without persistence work (preference=${trackPreferences})`, async () => {
    const requests: unknown[] = []
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { crypto: globalThis.crypto },
    })
    mockWindows(trackPreferences ? 'preference' : 'main')
    mockIPC((command, payload) => {
      if (command === 'plugin:pinia|load') return {}
      if (command === 'plugin:pinia|patch') requests.push(payload)
      return null
    }, { shouldMockEvents: true })
    let stopWatching: (() => void) | undefined
    let stopStore: (() => Promise<void>) | undefined
    try {
      const pinia = createPinia()
      pinia.use(createPersistentStorePlugin(trackPreferences))
      createApp({}).use(pinia)
      let projections = 0
      const useModel = defineStore('model', () => ({
        selected: ref('initial'),
        ...createModelInputState(),
      }), {
        tauri: {
          hooks: {
            beforeBackendSync: (state) => {
              projections += 1
              return { selected: state.selected }
            },
          },
        },
      })
      const store = useModel(pinia)
      await store.$tauri.start()
      stopStore = () => store.$tauri.stop()
      let reactiveUpdates = 0
      stopWatching = watch([store.activeKeys, store.pressedKeys], () => {
        reactiveUpdates += 1
      }, { deep: true })
      store.activeKeys.A = true
      store.pressedKeys.A = [{ path: 'left.png', type: 'left' }]
      await nextTick()
      delete store.activeKeys.A
      delete store.pressedKeys.A
      await nextTick()
      await flushPreferenceSync()
      assert.equal(reactiveUpdates, 2)
      assert.equal(projections, 0)
      assert.equal(requests.length, 0)
      assert.equal('activeKeys' in store.$state, false)
      assert.equal('pressedKeys' in store.$state, false)

      store.selected = 'changed'
      await nextTick()
      await flushPreferenceSync()
      assert.equal(projections, 1)
      assert.equal(requests.length, 1)
    } finally {
      stopWatching?.()
      await stopStore?.()
      clearMocks()
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })
}

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
