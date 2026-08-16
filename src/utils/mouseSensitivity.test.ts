import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import { describe, it } from 'node:test'

import { applyMouseSensitivity } from './mouseSensitivity'

describe('applyMouseSensitivity', () => {
  it('preserves the existing response at 100 percent', () => {
    assert.equal(applyMouseSensitivity(0.25, 100), 0.25)
    assert.equal(applyMouseSensitivity(0.75, 100), 0.75)
  })

  it('keeps the response centered at zero percent', () => {
    assert.equal(applyMouseSensitivity(0, 0), 0.5)
    assert.equal(applyMouseSensitivity(1, 0), 0.5)
  })

  it('amplifies movement around the center and clamps to the valid range', () => {
    assert.equal(applyMouseSensitivity(0.25, 200), 0)
    assert.equal(applyMouseSensitivity(0.75, 200), 1)
    assert.ok(Math.abs(applyMouseSensitivity(0.4, 200) - 0.3) < Number.EPSILON)
    assert.ok(Math.abs(applyMouseSensitivity(0.6, 200) - 0.7) < Number.EPSILON)
  })

  it('handles malformed and out-of-range values defensively', () => {
    assert.equal(applyMouseSensitivity(Number.NaN, 100), 0.5)
    assert.equal(applyMouseSensitivity(0.25, Number.NaN), 0.25)
    assert.equal(applyMouseSensitivity(0.25, -100), 0.5)
    assert.ok(Math.abs(applyMouseSensitivity(0.4, 1000) - 0.3) < Number.EPSILON)
  })
})
