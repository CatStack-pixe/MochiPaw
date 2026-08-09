import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import type {
  TypingStatsOperationAcknowledgement,
  TypingStatsOperationRequest,
  TypingStatsRequestAdapter,
} from './typingStatsRequest'

import { PromiseTimeoutError } from './promise'
import { requestTypingStatsOperation } from './typingStatsRequest'

test('registers the acknowledgement listener before emitting and returns the accepted result', async () => {
  const order: string[] = []
  let acknowledge: ((acknowledgement: TypingStatsOperationAcknowledgement) => void) | undefined
  const adapter: TypingStatsRequestAdapter = {
    listen: async (callback) => {
      order.push('listen')
      acknowledge = callback

      return () => {
        order.push('unlisten')
      }
    },
    emit: async (request) => {
      order.push('emit')
      assert(acknowledge)
      acknowledge({
        accepted: true,
        requestId: request.requestId,
        state: { dailyCounts: { '2026-08-09': 4 }, enabled: true },
      })
    },
  }

  const result = await requestTypingStatsOperation({ kind: 'set-enabled', enabled: true }, { adapter })

  assert.deepEqual(order, ['listen', 'emit', 'unlisten'])
  assert.equal(result.accepted, true)
  assert.deepEqual(result.state, { dailyCounts: { '2026-08-09': 4 }, enabled: true })
})

test('ignores acknowledgements for a different request ID', async () => {
  let acknowledge: ((acknowledgement: TypingStatsOperationAcknowledgement) => void) | undefined
  let emittedRequest: TypingStatsOperationRequest | undefined
  const adapter: TypingStatsRequestAdapter = {
    listen: async (callback) => {
      acknowledge = callback
      return () => undefined
    },
    emit: async (request) => {
      emittedRequest = request
      assert(acknowledge)
      acknowledge({ accepted: false, reason: 'stale', requestId: 'another-request' })
      acknowledge({ accepted: true, requestId: request.requestId })
    },
  }

  const result = await requestTypingStatsOperation({ kind: 'clear-history' }, { adapter })

  assert.equal(result.accepted, true)
  assert.equal(result.requestId, emittedRequest?.requestId)
})

test('unlistens when emitting fails', async () => {
  let unlistenCount = 0
  const adapter: TypingStatsRequestAdapter = {
    listen: async () => () => {
      unlistenCount += 1
    },
    emit: async () => {
      throw new Error('emit failed')
    },
  }

  await assert.rejects(
    requestTypingStatsOperation({ kind: 'flush', pauseId: 'exit-1' }, { adapter }),
    /emit failed/,
  )
  assert.equal(unlistenCount, 1)
})

test('unlistens when acknowledgement times out', async () => {
  let unlistenCount = 0
  const adapter: TypingStatsRequestAdapter = {
    listen: async () => () => {
      unlistenCount += 1
    },
    emit: async () => undefined,
  }

  await assert.rejects(
    requestTypingStatsOperation({ kind: 'flush', pauseId: 'exit-1' }, { adapter, timeoutMs: 5 }),
    (error: unknown) => {
      assert(error instanceof PromiseTimeoutError)
      return true
    },
  )
  assert.equal(unlistenCount, 1)
})
