// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { getMouseLookParameterValue, mirrorMouseLookPosition } from './mouseLook'
import { applyMouseSensitivity } from './mouseSensitivity'

test('mirrors each axis independently for all four toggle combinations', () => {
  const position = { x: 0.25, y: 0.75 }

  for (const mirrorX of [false, true]) {
    for (const mirrorY of [false, true]) {
      const mirrored = mirrorMouseLookPosition(position, mirrorX, mirrorY)
      assert.deepEqual(mirrored, {
        x: mirrorX ? 0.75 : 0.25,
        y: mirrorY ? 0.25 : 0.75,
      })
      const range = { min: -30, max: 30 }
      assert.equal(getMouseLookParameterValue('X', range, mirrored), mirrorX ? -15 : 15)
      assert.equal(getMouseLookParameterValue('Y', range, mirrored), mirrorY ? 15 : -15)
      assert.equal(1 - 2 * mirrored.x, mirrorX ? -0.5 : 0.5)
      assert.equal(1 - 2 * mirrored.y, mirrorY ? 0.5 : -0.5)
    }
  }
  assert.deepEqual(position, { x: 0.25, y: 0.75 })
})

test('keeps legacy omitted mirror flags disabled', () => {
  assert.deepEqual(mirrorMouseLookPosition({ x: 0.25, y: 0.75 }), { x: 0.25, y: 0.75 })
  assert.deepEqual(mirrorMouseLookPosition({ x: 0.25, y: 0.75 }, true), { x: 0.75, y: 0.75 })
})

test('sweeps asymmetric X and Y ranges without out-of-range values', () => {
  for (const axis of ['X', 'Y'] as const) {
    for (const range of [{ min: 0, max: 1 }, { min: -10, max: 30 }, { min: -5, max: -1 }]) {
      for (const mirrored of [false, true]) {
        for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
          const position = mirrorMouseLookPosition({ x: ratio, y: ratio }, mirrored, mirrored)
          const value = getMouseLookParameterValue(axis, range, position)
          const expected = mirrored
            ? range.min + ratio * (range.max - range.min)
            : range.max - ratio * (range.max - range.min)
          assert.equal(value, expected)
          assert.ok(value >= range.min && value <= range.max)
        }
      }
    }
  }
})

test('keeps the neutral midpoint and fixed-value ranges unchanged by mirroring', () => {
  for (const axis of ['X', 'Y'] as const) {
    const centered = mirrorMouseLookPosition({ x: 0.5, y: 0.5 }, true, true)
    assert.equal(getMouseLookParameterValue(axis, { min: -10, max: 30 }, centered), 10)
    for (const ratio of [0, 0.5, 1]) {
      const position = mirrorMouseLookPosition({ x: ratio, y: ratio }, true, true)
      assert.equal(getMouseLookParameterValue(axis, { min: 5, max: 5 }, position), 5)
    }
  }
})

test('reverses roll for exactly one mirrored axis and preserves it for both', () => {
  const position = { x: 0.25, y: 0.75 }
  const range = { min: -30, max: 30 }
  assert.equal(getMouseLookParameterValue('Z', range, position), 7.5)
  for (const mirrorX of [false, true]) {
    for (const mirrorY of [false, true]) {
      const mirrored = mirrorMouseLookPosition(position, mirrorX, mirrorY)
      assert.equal(getMouseLookParameterValue('Z', range, mirrored), mirrorX === mirrorY ? 7.5 : -7.5)
    }
  }
})

test('preserves the legacy symmetric response with Y mirroring disabled', () => {
  for (const x of [0, 0.25, 0.5, 0.75, 1]) {
    for (const y of [0, 0.25, 0.5, 0.75, 1]) {
      for (const mirrorX of [false, true]) {
        const position = mirrorMouseLookPosition({ x, y }, mirrorX, false)
        const sign = mirrorX ? -1 : 1
        const range = { min: -30, max: 30 }
        assert.equal(Math.abs(getMouseLookParameterValue('X', range, position) - sign * (30 - 60 * x)), 0)
        assert.equal(Math.abs(getMouseLookParameterValue('Y', range, position) - (30 - 60 * y)), 0)
        assert.equal(Math.abs(getMouseLookParameterValue('Z', range, position) - sign * (1 - 2 * x) * (1 - 2 * y) * -30), 0)
      }
    }
  }
})

test('uses sensitivity-adjusted coordinates for both model parameters and look targets', () => {
  const position = mirrorMouseLookPosition({
    x: applyMouseSensitivity(0.25, 200),
    y: applyMouseSensitivity(0.75, 200),
  }, true, true)
  assert.deepEqual(position, { x: 1, y: 0 })
  assert.equal(getMouseLookParameterValue('X', { min: 0, max: 1 }, position), 0)
  assert.equal(getMouseLookParameterValue('Y', { min: 0, max: 1 }, position), 1)
  assert.deepEqual({ x: 1 - 2 * position.x, y: 1 - 2 * position.y }, { x: -1, y: 1 })
})
