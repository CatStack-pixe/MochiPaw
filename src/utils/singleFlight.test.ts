import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { createSingleFlightRunner } from './singleFlight'

test('runs one operation per command until it settles', async () => {
  const runner = createSingleFlightRunner<'pause' | 'resume'>()
  let resolve!: () => void
  const operation = new Promise<void>((res) => {
    resolve = res
  })
  let calls = 0

  const first = runner.run('pause', async () => {
    calls += 1
    await operation
  })
  const duplicate = runner.run('pause', async () => {
    calls += 1
  })

  assert.ok(first)
  assert.equal(duplicate, undefined)
  await Promise.resolve()
  assert.equal(calls, 1)

  resolve()
  await first

  await runner.run('pause', async () => {
    calls += 1
  })
  assert.equal(calls, 2)
})
