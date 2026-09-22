// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import type { WebviewMemoryTarget } from '@/plugins/window'

import { WEBVIEW_IDLE_TIMEOUT, WebviewIdleMemoryController } from './webviewIdleMemory'

class FakeTimers {
  now = 0
  private nextId = 1
  private timers = new Map<number, { callback: () => void, dueAt: number }>()

  setTimeout = (callback: () => void, delay: number) => {
    const id = this.nextId++
    this.timers.set(id, { callback, dueAt: this.now + delay })
    return id as unknown as ReturnType<typeof setTimeout>
  }

  clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
    this.timers.delete(timer as unknown as number)
  }

  advanceBy(duration: number) {
    const destination = this.now + duration

    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= destination)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0]

      if (!next) break

      const [id, timer] = next
      this.now = timer.dueAt
      this.timers.delete(id)
      timer.callback()
    }

    this.now = destination
  }
}

function createController() {
  const timers = new FakeTimers()
  const targets: WebviewMemoryTarget[] = []
  const controller = new WebviewIdleMemoryController({
    setTarget: async (target) => {
      targets.push(target)
      return true
    },
    now: () => timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  })

  return { controller, targets, timers }
}

function createControllerWithIdlePolicy(allowIdleLow: () => boolean) {
  const timers = new FakeTimers()
  const targets: WebviewMemoryTarget[] = []
  const controller = new WebviewIdleMemoryController({
    setTarget: async (target) => {
      targets.push(target)
      return true
    },
    allowIdleLow,
    now: () => timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  })

  return { controller, targets, timers }
}

test('switches to low after 60 seconds of inactivity', () => {
  const { controller, targets, timers } = createController()
  controller.start()

  timers.advanceBy(WEBVIEW_IDLE_TIMEOUT - 1)
  assert.deepEqual(targets, [])

  timers.advanceBy(1)
  assert.deepEqual(targets, ['low'])
})

test('input restores normal and resets the idle timeout', async () => {
  const { controller, targets, timers } = createController()
  controller.start()
  timers.advanceBy(WEBVIEW_IDLE_TIMEOUT)
  await Promise.resolve()

  controller.activity()
  await Promise.resolve()
  timers.advanceBy(WEBVIEW_IDLE_TIMEOUT - 1)
  assert.deepEqual(targets, ['low', 'normal'])

  timers.advanceBy(1)
  assert.deepEqual(targets, ['low', 'normal', 'low'])
})

test('visible animation windows stay normal during idle time', () => {
  const { controller, targets, timers } = createControllerWithIdlePolicy(() => false)
  controller.start()

  timers.advanceBy(WEBVIEW_IDLE_TIMEOUT * 2)
  assert.deepEqual(targets, [])

  controller.setHidden(true)
  assert.deepEqual(targets, ['low'])
})

test('hidden windows switch to low immediately and restore when shown', async () => {
  const { controller, targets } = createController()
  controller.start()

  controller.setHidden(true)
  controller.setHidden(false)
  await Promise.resolve()

  assert.deepEqual(targets, ['low', 'normal'])
})

test('deduplicates repeated target changes', async () => {
  const { controller, targets, timers } = createController()
  controller.start()

  controller.activity()
  controller.activity()
  controller.setHidden(true)
  controller.setHidden(true)
  controller.activity()
  assert.deepEqual(targets, ['low'])
  await Promise.resolve()

  controller.activate()
  controller.activity()
  await Promise.resolve()
  timers.advanceBy(WEBVIEW_IDLE_TIMEOUT)
  assert.deepEqual(targets, ['low', 'normal', 'low'])
})

test('throttles repeated mouse movement', () => {
  const { controller, targets, timers } = createController()
  controller.start()

  controller.mouseMove()
  timers.advanceBy(500)
  controller.mouseMove()
  timers.advanceBy(WEBVIEW_IDLE_TIMEOUT - 500)

  assert.deepEqual(targets, ['low'])
})

test('dispose clears the pending idle timer', () => {
  const { controller, targets, timers } = createController()
  controller.start()
  controller.dispose()

  timers.advanceBy(WEBVIEW_IDLE_TIMEOUT)
  assert.deepEqual(targets, [])
})

function createDeferredController() {
  const timers = new FakeTimers()
  const requests: Array<{
    target: WebviewMemoryTarget
    resolve: (applied: boolean) => void
    reject: (error: Error) => void
  }> = []
  const controller = new WebviewIdleMemoryController({
    setTarget: target => new Promise<boolean>((resolve, reject) => {
      requests.push({ target, resolve, reject })
    }),
    now: () => timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  })
  return { controller, requests }
}

test('waits for a slow low-memory request before restoring the visible target', async () => {
  const { controller, requests } = createDeferredController()
  controller.start(true)
  controller.activate()
  assert.deepEqual(requests.map(request => request.target), ['low'])

  requests[0]!.resolve(true)
  await Promise.resolve()
  assert.deepEqual(requests.map(request => request.target), ['low', 'normal'])
  requests[1]!.resolve(true)
  await Promise.resolve()
  controller.activity()
  assert.equal(requests.length, 2)
  controller.dispose()
})

test('coalesces rapid visibility changes without retaining intermediate requests', async () => {
  const { controller, requests } = createDeferredController()
  controller.start(true)
  for (let index = 0; index < 100; index += 1) {
    controller.activate()
    controller.setHidden(true)
  }
  assert.equal(requests.length, 1)
  requests[0]!.resolve(true)
  await Promise.resolve()
  assert.equal(requests.length, 1)
  controller.dispose()
})

test('disposal drops a queued target after the native request completes', async () => {
  const { controller, requests } = createDeferredController()
  controller.start(true)
  controller.activate()
  controller.dispose()
  requests[0]!.resolve(true)
  await Promise.resolve()
  controller.activate()
  assert.deepEqual(requests.map(request => request.target), ['low'])
})

test('failed requests preserve the latest target and retry only after later activity', async () => {
  const { controller, requests } = createDeferredController()
  controller.start(true)
  controller.activate()
  requests[0]!.reject(new Error('native request failed'))
  await Promise.resolve()
  assert.deepEqual(requests.map(request => request.target), ['low', 'normal'])

  requests[1]!.resolve(false)
  await Promise.resolve()
  assert.equal(requests.length, 2)
  controller.activity()
  assert.deepEqual(requests.map(request => request.target), ['low', 'normal', 'normal'])
  requests[2]!.resolve(true)
  await Promise.resolve()
  controller.activity()
  assert.equal(requests.length, 3)
  controller.dispose()
})

test('uses browser timers with the global receiver', () => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const timer = {} as ReturnType<typeof setTimeout>

  globalThis.setTimeout = function (this: typeof globalThis) {
    assert.equal(this, globalThis)
    return timer
  } as unknown as typeof setTimeout
  globalThis.clearTimeout = function (this: typeof globalThis, receivedTimer) {
    assert.equal(this, globalThis)
    assert.equal(receivedTimer, timer)
  } as typeof clearTimeout

  try {
    const controller = new WebviewIdleMemoryController({ setTarget: async () => true })
    controller.start()
    controller.dispose()
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})
