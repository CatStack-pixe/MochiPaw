import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { PromiseTimeoutError, withTimeout } from './promise'

test('returns the promise result before the timeout', async () => {
  const result = await withTimeout(Promise.resolve('ready'), 10, 'timed out')

  assert.equal(result, 'ready')
})

test('rejects with a timeout error when the promise does not settle', async () => {
  await assert.rejects(
    withTimeout(new Promise(() => undefined), 10, 'operation timed out'),
    (error: unknown) => {
      assert(error instanceof PromiseTimeoutError)
      assert.equal(error.message, 'operation timed out')
      return true
    },
  )
})
