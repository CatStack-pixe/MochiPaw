import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import {
  persistStateWhenWritable,
  runAfterSavingPersistentStores,
  saveAllPersistentStoresNow,
} from './persistence'

test('keeps core store updates in writable windows', () => {
  const state = { currentModelId: 'model-id' }

  assert.equal(persistStateWhenWritable(state, true), state)
})

test('drops core store updates in read-only submodel windows', () => {
  assert.equal(persistStateWhenWritable({ currentModelId: 'runtime-fallback' }, false), undefined)
})

test('flushes main-window typing statistics before saving all stores', async () => {
  const order: string[] = []

  await saveAllPersistentStoresNow({
    flushTypingStats: async () => {
      order.push('flush-typing-stats')
    },
    resumeTypingStats: async () => {},
    saveAll: async () => {
      order.push('save-all')
    },
  })

  assert.deepEqual(order, ['flush-typing-stats', 'save-all'])
})

test('does not save stale backend state when typing statistics cannot flush', async () => {
  let saved = false
  let resumed = false

  await assert.rejects(
    saveAllPersistentStoresNow({
      flushTypingStats: async () => {
        throw new Error('main window unavailable')
      },
      resumeTypingStats: async () => {
        resumed = true
      },
      saveAll: async () => {
        saved = true
      },
    }),
    /main window unavailable/,
  )
  assert.equal(saved, false)
  assert.equal(resumed, true)
})

test('resumes buffered typing input when the final save fails', async () => {
  const order: string[] = []

  await assert.rejects(
    saveAllPersistentStoresNow({
      flushTypingStats: async () => {
        order.push('flush-typing-stats')
      },
      resumeTypingStats: async () => {
        order.push('resume-typing-stats')
      },
      saveAll: async () => {
        order.push('save-all')
        throw new Error('save failed')
      },
    }),
    /save failed/,
  )

  assert.deepEqual(order, ['flush-typing-stats', 'save-all', 'resume-typing-stats'])
})

test('resumes buffered typing input when the process action fails', async () => {
  const order: string[] = []

  await assert.rejects(
    runAfterSavingPersistentStores(
      async () => {
        order.push('relaunch')
        throw new Error('relaunch failed')
      },
      {
        flushTypingStats: async () => {
          order.push('flush-typing-stats')
        },
        resumeTypingStats: async () => {
          order.push('resume-typing-stats')
        },
        saveAll: async () => {
          order.push('save-all')
        },
      },
    ),
    /relaunch failed/,
  )

  assert.deepEqual(order, ['flush-typing-stats', 'save-all', 'relaunch', 'resume-typing-stats'])
})

test('keeps typing input paused when the process action succeeds', async () => {
  const order: string[] = []

  await runAfterSavingPersistentStores(
    async () => {
      order.push('exit')
    },
    {
      flushTypingStats: async () => {
        order.push('flush-typing-stats')
      },
      resumeTypingStats: async () => {
        order.push('resume-typing-stats')
      },
      saveAll: async () => {
        order.push('save-all')
      },
    },
  )

  assert.deepEqual(order, ['flush-typing-stats', 'save-all', 'exit'])
})

test('reuses the in-flight terminal action when invoked concurrently', async () => {
  const order: string[] = []
  let releaseSave!: () => void

  const adapter = {
    flushTypingStats: async () => {
      order.push('flush-typing-stats')
    },
    resumeTypingStats: async () => {
      order.push('resume-typing-stats')
    },
    saveAll: () => new Promise<void>((resolve) => {
      order.push('save-all')
      releaseSave = resolve
    }),
  }

  const first = runAfterSavingPersistentStores(
    async () => {
      order.push('first-action')
    },
    adapter,
  )
  await new Promise(resolve => setImmediate(resolve))

  const second = runAfterSavingPersistentStores(
    async () => {
      order.push('second-action')
    },
    adapter,
  )

  releaseSave()
  await Promise.all([first, second])

  assert.deepEqual(order, ['flush-typing-stats', 'save-all', 'first-action'])
})
