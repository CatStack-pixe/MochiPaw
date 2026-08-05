import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { getModelDisplayName, getSubModelDisplayName, mergeModelCatalog } from './model'

test('recovers custom model directories missing from persisted catalog', () => {
  const persisted = [
    { id: 'existing', path: 'C:/old/existing', mode: 'standard' as const, isPreset: false },
  ]
  const discovered = [
    { id: 'existing', path: 'C:/app-data/existing', mode: 'standard' as const, isPreset: false },
    { id: 'recovered', path: 'C:/app-data/recovered', mode: 'keyboard' as const, isPreset: false },
  ]

  assert.deepEqual(mergeModelCatalog(persisted, discovered), [
    { id: 'existing', path: 'C:/app-data/existing', mode: 'standard', isPreset: false },
    { id: 'recovered', path: 'C:/app-data/recovered', mode: 'keyboard', isPreset: false },
  ])
})

test('uses custom, metadata, and internal model names in priority order', () => {
  assert.equal(getModelDisplayName({ id: 'preset-standard', displayName: 'Standard', customName: 'Desk cat' }), 'Desk cat')
  assert.equal(getModelDisplayName({ id: 'preset-standard', displayName: 'Standard', customName: '  ' }), 'Standard')
  assert.equal(getModelDisplayName({ id: 'preset-standard' }), 'preset-standard')
})

test('uses an instance name before falling back to its model name', () => {
  const model = { id: 'preset-standard', customName: 'Desk cat' }

  assert.equal(getSubModelDisplayName({ modelId: model.id, customName: 'Left monitor' }, model), 'Left monitor')
  assert.equal(getSubModelDisplayName({ modelId: model.id }, model), 'Desk cat')
  assert.equal(getSubModelDisplayName({ modelId: 'missing-model' }), 'missing-model')
})
