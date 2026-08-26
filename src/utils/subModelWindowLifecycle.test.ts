import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import { describe, it } from 'node:test'

import { SubModelWindowLifecycle } from './subModelWindowLifecycle'

describe('SubModelWindowLifecycle', () => {
  it('invalidates an older lifecycle generation', () => {
    const lifecycle = new SubModelWindowLifecycle()
    const firstGeneration = lifecycle.begin('instance')
    const secondGeneration = lifecycle.begin('instance')

    assert.equal(lifecycle.isCurrent('instance', firstGeneration), false)
    assert.equal(lifecycle.isCurrent('instance', secondGeneration), true)
  })

  it('cancels a pending operation when a newer lifecycle operation begins', async () => {
    const lifecycle = new SubModelWindowLifecycle()
    const generation = lifecycle.begin('instance')
    const cancellation = lifecycle.onChange('instance', generation)
    const cancelled = cancellation.promise.then(() => true)

    lifecycle.begin('instance')

    assert.equal(await cancelled, true)
  })

  it('does not retain disposed cancellation listeners', async () => {
    const lifecycle = new SubModelWindowLifecycle()
    const generation = lifecycle.begin('instance')
    const cancellation = lifecycle.onChange('instance', generation)

    cancellation.dispose()
    lifecycle.begin('instance')

    const result = await Promise.race([
      cancellation.promise.then(() => 'cancelled'),
      new Promise(resolve => setTimeout(() => resolve('pending'), 0)),
    ])

    assert.equal(result, 'pending')
  })
})
