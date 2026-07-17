import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { getWindowRecoveryPosition } from './windowPosition'

test('does not return the pet to a screen during a normal drag', () => {
  const windowPosition = { x: 1900, y: 100 }
  const windowSize = { width: 300, height: 300 }
  const monitor = { x: 0, y: 0, width: 1920, height: 1080 }

  assert.equal(getWindowRecoveryPosition('moved', windowPosition, windowSize, monitor), undefined)
  assert.equal(getWindowRecoveryPosition('resized', windowPosition, windowSize, monitor), undefined)
  assert.equal(getWindowRecoveryPosition('scale-changed', windowPosition, windowSize, monitor), undefined)
})

test('returns the pet to a screen only on explicit request', () => {
  const position = getWindowRecoveryPosition(
    'manual',
    { x: 1900, y: 100 },
    { width: 300, height: 300 },
    { x: 0, y: 0, width: 1920, height: 1080 },
  )

  assert.deepEqual(position, { x: 1620, y: 100 })
})

test('returns an oversized window to the monitor origin', () => {
  const position = getWindowRecoveryPosition(
    'manual',
    { x: -400, y: -300 },
    { width: 2400, height: 1400 },
    { x: 0, y: 0, width: 1920, height: 1080 },
  )

  assert.deepEqual(position, { x: 0, y: 0 })
})
