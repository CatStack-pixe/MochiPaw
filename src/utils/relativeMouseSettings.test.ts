// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'
import { createPinia } from 'pinia'

import { useCatStore } from '../stores/cat'

test('new settings use half relative sensitivity without changing absolute sensitivity', () => {
  const store = useCatStore(createPinia())
  assert.equal(store.model.relativeMouseSensitivity, 0.5)
  assert.equal(store.model.mouseSensitivity, 100)
})

test('legacy settings gain half relative sensitivity without resetting other mouse preferences', () => {
  const store = useCatStore(createPinia())
  store.migrated = true
  store.model.mouseSensitivity = 130
  store.model.mouseMirror = true
  store.model.mouseLookSmoothing = 40
  Reflect.deleteProperty(store.model, 'relativeMouseSensitivity')
  const before = { ...store.model }

  store.init()

  assert.deepEqual({ ...store.model }, { ...before, relativeMouseSensitivity: 0.5 })
})

test('custom relative multipliers survive settings serialization and initialization', () => {
  for (const multiplier of [0, 0.25, 0.5, 1, 2.75, 5]) {
    const original = useCatStore(createPinia())
    original.migrated = true
    original.model.relativeMouseSensitivity = multiplier
    original.model.mouseSensitivity = 125

    const restored = useCatStore(createPinia())
    restored.$patch(JSON.parse(JSON.stringify(original.$state)))
    restored.init()

    assert.equal(restored.model.relativeMouseSensitivity, multiplier)
    assert.equal(restored.model.mouseSensitivity, 125)
  }
})

test('normalizes malformed persisted multipliers before the migration early return', () => {
  for (const value of [undefined, null, '0.25', true, Number.NaN, Infinity]) {
    const store = useCatStore(createPinia())
    store.migrated = true
    Object.assign(store.model, { relativeMouseSensitivity: value })

    store.init()

    assert.equal(store.model.relativeMouseSensitivity, 0.5)
  }
})
