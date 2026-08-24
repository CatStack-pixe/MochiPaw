import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import {
  MODEL_STORE_SCHEMA_VERSION,
  prepareModelStoreStateForBackend,
  prepareModelStoreStateForFrontend,
  resolvePersistedModelSelection,
} from './modelStorePersistence'

const models = [
  { id: 'preset-standard', fingerprint: 'preset' },
  { id: 'custom-new', fingerprint: 'same-content' },
]

test('loads the legacy currentModel when the persisted selection still needs migration', () => {
  const legacy = { id: 'custom-old', fingerprint: 'same-content', path: 'C:\\旧目录\\模型' }
  const prepared = prepareModelStoreStateForFrontend({ currentModel: legacy, models })

  assert.deepEqual(prepared.currentModel, legacy)
  assert.deepEqual(prepared.models, models)
})

test('ignores a stale legacy currentModel after stable selection migration completed', () => {
  const staleLegacy = { id: 'custom-missing', fingerprint: 'same-content', path: 'C:\\missing\\model' }
  const prepared = prepareModelStoreStateForFrontend({
    schemaVersion: MODEL_STORE_SCHEMA_VERSION,
    currentModelId: 'custom-missing',
    currentModel: staleLegacy,
    models,
    selectionMigrationPending: false,
  })

  assert.equal(prepared.currentModel, undefined)
  assert.equal(prepared.currentModelId, 'custom-missing')
  assert.deepEqual(prepared.models, models)
})

test('keeps the legacy currentModel while an explicit selection migration is pending', () => {
  const legacy = { id: 'custom-old', fingerprint: 'same-content', path: 'C:\\old\\model' }
  const prepared = prepareModelStoreStateForFrontend({
    schemaVersion: MODEL_STORE_SCHEMA_VERSION,
    currentModelId: 'custom-old',
    currentModel: legacy,
    models,
    selectionMigrationPending: true,
  })

  assert.deepEqual(prepared.currentModel, legacy)
})

test('persists only the model whitelist and strips runtime leases', () => {
  const persisted = prepareModelStoreStateForBackend({
    schemaVersion: 1,
    currentModelId: 'custom-new',
    currentModelFingerprint: 'same-content',
    currentModel: { id: 'custom-new', path: 'C:\\absolute\\path' },
    models: [{ id: 'custom-new', path: 'C:\\installed', runtimeLease: { expiresAt: 1 } }],
    shortcuts: { Tap: 'Space' },
    behaviorNames: {},
    behaviorGroups: {},
    subModels: [],
    modelReady: false,
    currentMotions: [['Idle', []]],
    currentExpressions: [],
    supportKeys: { Space: [] },
    pressedKeys: {},
    activeKeys: {},
  }, true)

  assert.deepEqual(persisted, {
    schemaVersion: MODEL_STORE_SCHEMA_VERSION,
    currentModelId: 'custom-new',
    currentModelFingerprint: 'same-content',
    models: [{ id: 'custom-new', path: 'C:\\installed' }],
    shortcuts: { Tap: 'Space' },
    behaviorNames: {},
    behaviorGroups: {},
    subModels: [],
  })
})

test('does not prepare model state for a read-only submodel window', () => {
  assert.equal(prepareModelStoreStateForBackend({ currentModelId: 'custom-new' }, false), undefined)
})

test('prefers the stable persisted model ID', () => {
  const selection = resolvePersistedModelSelection(models, 'custom-new', { id: 'preset-standard' })

  assert.equal(selection.model?.id, 'custom-new')
  assert.equal(selection.currentModelId, 'custom-new')
  assert.equal(selection.selectionMigrated, false)
})

test('migrates a legacy model by ID and then by fingerprint', () => {
  const byId = resolvePersistedModelSelection(models, undefined, { id: 'custom-new' })
  const byFingerprint = resolvePersistedModelSelection(models, undefined, {
    id: 'custom-old',
    fingerprint: 'same-content',
  })

  assert.equal(byId.currentModelId, 'custom-new')
  assert.equal(byFingerprint.model?.id, 'custom-new')
  assert.equal(byFingerprint.currentModelId, 'custom-new')
  assert.equal(byFingerprint.selectionMigrated, true)
})

test('uses a runtime fallback without overwriting a missing saved ID', () => {
  const selection = resolvePersistedModelSelection(models, 'temporarily-missing')

  assert.equal(selection.model?.id, 'preset-standard')
  assert.equal(selection.currentModelId, 'temporarily-missing')
  assert.equal(selection.usedRuntimeFallback, true)
})

test('does not overwrite a missing stable ID when its fingerprint matches another model', () => {
  const selection = resolvePersistedModelSelection(models, 'missing-old-id', {
    id: 'missing-old-id',
    fingerprint: 'same-content',
  })

  assert.equal(selection.model?.id, 'preset-standard')
  assert.equal(selection.currentModelId, 'missing-old-id')
  assert.equal(selection.currentModelFingerprint, 'same-content')
  assert.equal(selection.usedRuntimeFallback, true)
})

test('uses a fingerprint for an explicitly pending legacy migration', () => {
  const selection = resolvePersistedModelSelection(models, 'missing-old-id', {
    id: 'missing-old-id',
    fingerprint: 'same-content',
  }, true)

  assert.equal(selection.model?.id, 'custom-new')
  assert.equal(selection.currentModelId, 'custom-new')
  assert.equal(selection.selectionMigrated, true)
})

test('preserves a missing legacy ID while migrating the schema', () => {
  const selection = resolvePersistedModelSelection(models, undefined, { id: 'temporarily-missing' })

  assert.equal(selection.model?.id, 'preset-standard')
  assert.equal(selection.currentModelId, 'temporarily-missing')
  assert.equal(selection.selectionMigrated, true)
})

test('keeps the persisted catalog untouched after a transient scan failure', () => {
  const persisted = prepareModelStoreStateForBackend({
    currentModelId: 'custom-new',
    models: [{ id: 'custom-new', customName: 'Desk cat' }],
    shortcuts: {},
  }, true, false)

  assert.deepEqual(persisted, {
    schemaVersion: MODEL_STORE_SCHEMA_VERSION,
    currentModelId: 'custom-new',
    shortcuts: {},
  })
})

test('clears a removed selection after a successful catalog scan', () => {
  const persisted = prepareModelStoreStateForBackend({
    currentModelId: 'removed-model',
    currentModelFingerprint: 'old-fingerprint',
    selectionMigrationPending: true,
    models: [{ id: 'preset-standard' }],
  }, true)

  assert.deepEqual(persisted, {
    schemaVersion: MODEL_STORE_SCHEMA_VERSION,
    models: [{ id: 'preset-standard' }],
  })
})
