import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import { describe, it } from 'node:test'

import type { SubModelInstance } from '@/stores/model'

import { shouldIgnoreSubModelCursor } from './subModelWindow'

function createInstance(overrides: Partial<SubModelInstance> = {}): SubModelInstance {
  return {
    id: 'test-instance',
    modelId: 'test-model',
    visible: true,
    showOnLaunch: true,
    createdAt: 0,
    listeners: {
      keyboard: true,
      mouse: true,
      gamepad: true,
      typingBehavior: true,
    },
    window: {
      scale: 100,
      opacity: 100,
      radius: 0,
      passThrough: false,
      alwaysOnTop: false,
    },
    appearance: {
      mirror: false,
      mouseMirror: false,
      maxFPS: 60,
    },
    ...overrides,
  }
}

describe('shouldIgnoreSubModelCursor', () => {
  it('preserves configured interaction after the visible model is ready and rendering', () => {
    const interactive = createInstance()
    const passThrough = createInstance({
      window: {
        ...createInstance().window,
        passThrough: true,
      },
    })

    assert.equal(shouldIgnoreSubModelCursor(interactive, { modelReady: true, renderingEnabled: true }), false)
    assert.equal(shouldIgnoreSubModelCursor(passThrough, { modelReady: true, renderingEnabled: true }), true)
  })

  it('forces pass-through while the model is hidden or not ready', () => {
    const hidden = createInstance({ visible: false })
    const visible = createInstance()

    assert.equal(shouldIgnoreSubModelCursor(hidden, { modelReady: true, renderingEnabled: true }), true)
    assert.equal(shouldIgnoreSubModelCursor(visible, { modelReady: false, renderingEnabled: true }), true)
  })

  it('forces pass-through whenever rendering is disabled', () => {
    assert.equal(shouldIgnoreSubModelCursor(createInstance(), {
      modelReady: true,
      renderingEnabled: false,
    }), true)
  })
})
