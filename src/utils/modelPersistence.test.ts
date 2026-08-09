import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { requestModelStoreSave } from './modelPersistence'

test('awaits an explicit backend patch before saving the model store', async () => {
  const calls: Array<{ operation: string, value?: unknown }> = []

  await requestModelStoreSave({
    currentModelId: 'new-model',
    currentModel: { id: 'new-model', path: 'C:\\absolute\\path' },
    modelReady: false,
    models: [{ id: 'new-model', runtimeLease: { expiresAt: 1 } }],
  }, {
    adapter: {
      patch: async (storeId, state) => {
        calls.push({ operation: 'patch', value: { storeId, state } })
      },
      save: async (storeId) => {
        calls.push({ operation: 'save', value: storeId })
      },
    },
  })

  assert.deepEqual(calls, [
    {
      operation: 'patch',
      value: {
        storeId: 'model',
        state: {
          schemaVersion: 2,
          currentModelId: 'new-model',
          models: [{ id: 'new-model' }],
        },
      },
    },
    { operation: 'save', value: 'model' },
  ])
})

test('does not save or acknowledge persistence when the backend patch fails', async () => {
  let saved = false

  await assert.rejects(
    requestModelStoreSave({ currentModelId: 'new-model' }, {
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
