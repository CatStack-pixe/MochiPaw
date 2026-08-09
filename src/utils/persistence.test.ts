import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { persistStateWhenWritable } from './persistence'

test('keeps core store updates in writable windows', () => {
  const state = { currentModelId: 'model-id' }

  assert.equal(persistStateWhenWritable(state, true), state)
})

test('drops core store updates in read-only submodel windows', () => {
  assert.equal(persistStateWhenWritable({ currentModelId: 'runtime-fallback' }, false), undefined)
})
