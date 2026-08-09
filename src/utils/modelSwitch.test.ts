import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { executeModelSwitchTransaction } from './modelSwitch'

test('accepts a model switch only after loading, committing, and persisting', async () => {
  const order: string[] = []
  const result = await executeModelSwitchTransaction({
    loadTarget: () => {
      order.push('load')
    },
    commitSelection: () => {
      order.push('commit')
    },
    persistSelection: () => {
      order.push('persist')
    },
    rollbackSelection: () => {
      order.push('rollback')
    },
    restorePrevious: () => {
      order.push('restore')
    },
  })

  assert.deepEqual(order, ['load', 'commit', 'persist'])
  assert.deepEqual(result, { accepted: true })
})

test('rolls back without committing or saving when loading fails', async () => {
  const order: string[] = []
  let selectionCommitted: boolean | undefined
  const result = await executeModelSwitchTransaction({
    loadTarget: () => {
      order.push('load')
      throw new Error('model is invalid')
    },
    commitSelection: () => {
      order.push('commit')
    },
    persistSelection: () => {
      order.push('persist')
    },
    rollbackSelection: (committed) => {
      selectionCommitted = committed
      order.push('rollback')
    },
    restorePrevious: () => {
      order.push('restore')
    },
  })

  assert.deepEqual(order, ['load', 'rollback', 'restore'])
  assert.equal(selectionCommitted, false)
  assert.deepEqual(result, { accepted: false, reason: 'model is invalid' })
})

test('restores frontend and backend IDs when immediate persistence fails', async () => {
  let currentModelId = 'old-model'
  let backendModelId = 'old-model'
  const order: string[] = []
  const result = await executeModelSwitchTransaction({
    loadTarget: () => {
      order.push('load')
    },
    commitSelection: () => {
      order.push('commit')
      currentModelId = 'new-model'
    },
    persistSelection: () => {
      order.push('persist-new')
      backendModelId = currentModelId
      throw new Error('disk full')
    },
    rollbackSelection: (committed) => {
      assert.equal(committed, true)
      order.push('rollback-local')
      currentModelId = 'old-model'
      order.push('rollback-backend')
      backendModelId = currentModelId
    },
    restorePrevious: () => {
      order.push('restore')
    },
  })

  assert.equal(currentModelId, 'old-model')
  assert.equal(backendModelId, 'old-model')
  assert.deepEqual(order, [
    'load',
    'commit',
    'persist-new',
    'rollback-local',
    'rollback-backend',
    'restore',
  ])
  assert.deepEqual(result, { accepted: false, reason: 'disk full' })
})
