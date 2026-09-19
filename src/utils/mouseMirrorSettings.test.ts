// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'
import { createPinia } from 'pinia'

import { useCatStore } from '../stores/cat'
import { normalizeMouseMirrorY } from './mouseMirrorSettings'

test('preserves valid Y-axis mirror flags', () => {
  assert.equal(normalizeMouseMirrorY(true), true)
  assert.equal(normalizeMouseMirrorY(false), false)
})

test('defaults missing or malformed persisted flags to false without coercion', () => {
  for (const value of [undefined, null, 'true', 'false', '', 0, 1, [], {}, Number.NaN]) {
    assert.equal(normalizeMouseMirrorY(value), false)
  }
})

test('initializes legacy main settings without changing X mirror or appearance', () => {
  const store = useCatStore(createPinia())
  store.migrated = true
  store.model.mirror = true
  store.model.mouseMirror = true
  store.model.maxFPS = 144
  Reflect.deleteProperty(store.model, 'mouseMirrorY')
  const before = { ...store.model }

  store.init()

  assert.deepEqual({ ...store.model }, { ...before, mouseMirrorY: false })
})

test('normalizes main settings before the legacy migration early return', () => {
  for (const value of [true, false, undefined, null, 'true', 'false', 1]) {
    const store = useCatStore(createPinia())
    store.migrated = true
    Object.assign(store.model, { mouseMirrorY: value })

    store.init()

    assert.equal(store.model.mouseMirrorY, value === true)
  }
})
