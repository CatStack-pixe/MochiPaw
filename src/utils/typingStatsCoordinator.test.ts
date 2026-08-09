// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { TypingStatsOperationCoordinator } from './typingStatsCoordinator'

test('serializes inputs before and after an asynchronous operation', async () => {
  const coordinator = new TypingStatsOperationCoordinator<string>()
  const order: string[] = []
  let markOperationStarted!: () => void
  let finishOperation!: () => void
  const operationStarted = new Promise<void>((resolve) => {
    markOperationStarted = resolve
  })
  const operationGate = new Promise<void>((resolve) => {
    finishOperation = resolve
  })

  coordinator.record('before', input => order.push(input))
  const operation = coordinator.run(async () => {
    order.push('operation-start')
    markOperationStarted()
    await operationGate
    order.push('operation-end')
  })
  coordinator.record('after', input => order.push(input))

  await operationStarted
  assert.deepEqual(order, ['before', 'operation-start'])

  finishOperation()
  await operation
  await coordinator.run(() => undefined)

  assert.deepEqual(order, ['before', 'operation-start', 'operation-end', 'after'])
})

test('buffers paused inputs and replays them in order after a failed exit', async () => {
  const coordinator = new TypingStatsOperationCoordinator<string>()
  const recorded: string[] = []

  await coordinator.run(() => coordinator.pauseInputs('exit-1'))
  coordinator.record('KeyA', input => recorded.push(input))
  coordinator.record('KeyB', input => recorded.push(input))

  const replayed = await coordinator.run(() => coordinator.resumeInputs('exit-1', input => recorded.push(input)))

  assert.equal(replayed, 2)
  assert.deepEqual(recorded, ['KeyA', 'KeyB'])
})

test('keeps input paused until every window releases its pause token', async () => {
  const coordinator = new TypingStatsOperationCoordinator<string>()
  const recorded: string[] = []

  await coordinator.run(() => {
    coordinator.pauseInputs('main-exit')
    coordinator.pauseInputs('preference-restart')
  })
  coordinator.record('KeyA', input => recorded.push(input))

  const firstReplay = await coordinator.run(() => (
    coordinator.resumeInputs('main-exit', input => recorded.push(input))
  ))
  assert.equal(firstReplay, 0)
  assert.equal(recorded.length, 0)

  const finalReplay = await coordinator.run(() => (
    coordinator.resumeInputs('preference-restart', input => recorded.push(input))
  ))
  assert.equal(finalReplay, 1)
  assert.deepEqual(recorded, ['KeyA'])
})
