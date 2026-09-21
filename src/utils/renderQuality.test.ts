// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Tests use the project's Node test runner.
import test from 'node:test'
import { createPinia } from 'pinia'

import { useCatStore } from '../stores/cat'
import { normalizeRenderQuality, resolvePreviewResolution, resolveRenderResolution } from './renderQuality'

test('legacy and malformed settings use the balanced render budget', () => {
  for (const value of [undefined, null, '', 1, 'ultra', {}]) {
    assert.equal(normalizeRenderQuality(value), 'balanced')
    assert.equal(resolveRenderResolution(3, value), 2)
  }
})

test('render quality caps high DPI buffers while native preserves monitor resolution', () => {
  assert.equal(resolveRenderResolution(3, 'economy'), 1)
  assert.equal(resolveRenderResolution(3, 'balanced'), 2)
  assert.equal(resolveRenderResolution(3, 'native'), 3)
  assert.equal(resolvePreviewResolution(3), 1)
  assert.equal(resolveRenderResolution(1.25), 1.25)
  assert.equal(resolveRenderResolution(0.8, 'economy'), 0.8)
})

test('invalid monitor ratios do not create zero or unbounded render targets', () => {
  for (const ratio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveRenderResolution(ratio, 'native'), 1)
    assert.equal(resolvePreviewResolution(ratio), 1)
  }
})

test('older persisted stores gain a quality budget without changing user frame rate', () => {
  const store = useCatStore(createPinia())
  store.migrated = true
  store.model.maxFPS = 144
  Reflect.deleteProperty(store.model, 'renderQuality')
  store.init()
  assert.equal(store.model.renderQuality, 'balanced')
  assert.equal(store.model.maxFPS, 144)
  store.model.renderQuality = 'native'
  store.init()
  assert.equal(store.model.renderQuality, 'native')
})
