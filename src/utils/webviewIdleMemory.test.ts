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

test('switches to low after 60 seconds of inactivity', () => {
  const { controller, targets, timers } = createController()
  controller.start()

  timers.advanceBy(WEBVIEW_IDLE_TIMEOUT - 1)
  assert.deepEqual(targets, [])

  timers.advanceBy(1)
  assert.deepEqual(targets, ['low'])
})

test('input restores normal and resets the idle timeout', () => {
  const { controller, targets, timers } = createController()
  controller.start()
  timers.advanceBy(WEBVIEW_IDLE_TIMEOUT)

  controller.activity()
  timers.advanceBy(WEBVIEW_IDLE_TIMEOUT - 1)
  assert.deepEqual(targets, ['low', 'normal'])

  timers.advanceBy(1)
  assert.deepEqual(targets, ['low', 'normal', 'low'])
})

test('hidden windows switch to low immediately and restore when shown', () => {
  const { controller, targets } = createController()
  controller.start()

  controller.setHidden(true)
  controller.setHidden(false)

  assert.deepEqual(targets, ['low', 'normal'])
})

test('deduplicates repeated target changes', () => {
  const { controller, targets, timers } = createController()
  controller.start()

  controller.activity()
  controller.activity()
  controller.setHidden(true)
  controller.setHidden(true)
  controller.activity()
  assert.deepEqual(targets, ['low'])

  controller.activate()
  controller.activity()
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

test('uses browser timers with the global receiver', () => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const timer = {} as ReturnType<typeof setTimeout>

  globalThis.setTimeout = function (this: typeof globalThis) {
    assert.equal(this, globalThis)
    return timer
  } as typeof setTimeout
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
