import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import {
  getActiveMouseLookSmoothing,
  getMouseLookDampingDecay,
  getMouseLookInterpolationAlpha,
  normalizeMouseLookSmoothing,
  setActiveMouseLookSmoothing,
} from './mouseLookSmoothing'

test('normalizes mouse-look smoothing values within the supported range', () => {
  assert.equal(normalizeMouseLookSmoothing(0), 0)
  assert.equal(normalizeMouseLookSmoothing(75), 75)
  assert.equal(normalizeMouseLookSmoothing(100), 100)
  assert.equal(normalizeMouseLookSmoothing(-10), 0)
  assert.equal(normalizeMouseLookSmoothing(110), 100)
  assert.equal(normalizeMouseLookSmoothing('75'), 75)
  assert.equal(normalizeMouseLookSmoothing(Number.NaN), 75)
})

test('maps smoothing values to the direct, current, and strongest response levels', () => {
  assert.equal(getMouseLookDampingDecay(0), 0)
  assert.equal(getMouseLookDampingDecay(75), 0.75)
  assert.equal(getMouseLookDampingDecay(100), 0.95)

  const frameMS = 1000 / 60
  assert.equal(getMouseLookInterpolationAlpha(0, frameMS), 1)
  assert.ok(Math.abs(getMouseLookInterpolationAlpha(75, frameMS) - 0.25) < Number.EPSILON)
  assert.ok(Math.abs(getMouseLookInterpolationAlpha(100, frameMS) - 0.05) < Number.EPSILON)
})

test('keeps malformed smoothing input defensive when calculating interpolation', () => {
  assert.equal(getMouseLookDampingDecay(-10), 0)
  assert.equal(getMouseLookDampingDecay(110), 0.95)
  assert.equal(getMouseLookDampingDecay('invalid'), 0.75)
  assert.ok(getMouseLookInterpolationAlpha(Number.NaN, 1000 / 60) > 0)
})

test('reads and writes smoothing for the active mouse-look algorithm only', () => {
  const settings = {
    windowRelativeMouseLook: true,
    mouseLookSmoothing: 25,
    legacyMouseLookSmoothing: 85,
  }

  assert.equal(getActiveMouseLookSmoothing(settings), 25)
  assert.equal(setActiveMouseLookSmoothing(settings, 40), 40)
  assert.equal(settings.mouseLookSmoothing, 40)
  assert.equal(settings.legacyMouseLookSmoothing, 85)

  settings.windowRelativeMouseLook = false

  assert.equal(getActiveMouseLookSmoothing(settings), 85)
  assert.equal(setActiveMouseLookSmoothing(settings, 60), 60)
  assert.equal(settings.mouseLookSmoothing, 40)
  assert.equal(settings.legacyMouseLookSmoothing, 60)
})
