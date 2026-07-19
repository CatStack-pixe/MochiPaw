import type { PhysicalPosition } from '@tauri-apps/api/window'

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { getMonitorPoint } from './monitor'

test('uses global physical cursor coordinates for monitor lookup', () => {
  const cursorPosition = { x: -1440, y: 900 } as PhysicalPosition

  assert.deepEqual(getMonitorPoint(cursorPosition), { x: -1440, y: 900 })
})
