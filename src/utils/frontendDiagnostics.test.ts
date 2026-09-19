import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { formatFrontendError, installGlobalErrorHandlers } from './frontendDiagnostics'

test('formats Error values with useful diagnostic details', () => {
  const formatted = formatFrontendError(new Error('startup exploded'))

  assert.match(formatted, /^Error: startup exploded/)
})

test('formats primitive and cyclic rejection reasons without throwing', () => {
  assert.equal(formatFrontendError('network unavailable'), 'network unavailable')
  assert.equal(formatFrontendError(null), 'null')

  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.equal(formatFrontendError(cyclic), '[object Object]')
})

test('global handler installation is a no-op outside a browser window', () => {
  assert.doesNotThrow(() => installGlobalErrorHandlers())
})
