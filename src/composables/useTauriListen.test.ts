// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'
import { createRenderer } from 'vue'

import { useTauriListen } from './useTauriListen'

// Exercise actual Vue mount/unmount hooks without a browser DOM.
const renderer = createRenderer<object, object>({
  patchProp() {},
  insert() {},
  remove() {},
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  setText() {},
  setElementText() {},
  parentNode: () => null,
  nextSibling: () => null,
})

function createFixture() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const mockWindow = {
    crypto: globalThis.crypto,
    __TAURI_INTERNALS__: {} as {
      runCallback: (id: number, event: unknown) => void
    },
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: mockWindow })
  const removed: number[] = []
  const received: string[] = []
  let handlerId = 0
  let resolveListen!: (id: number) => void
  let rejectListen!: (error: Error) => void
  const registration = new Promise<number>((resolve, reject) => {
    resolveListen = resolve
    rejectListen = reject
  })
  mockIPC((command, payload) => {
    if (command === 'plugin:event|listen') {
      handlerId = (payload as { handler: number }).handler
      return registration
    }
    if (command === 'plugin:event|unlisten') removed.push((payload as { eventId: number }).eventId)
    return null
  })
  let ready!: Promise<void>
  const app = renderer.createApp({
    setup() {
      ready = useTauriListen<string>('lifecycle-test', event => received.push(event.payload)).ready
      return () => null
    },
  })
  app.mount({})
  let unmounted = false
  const unmount = () => {
    if (unmounted) return
    unmounted = true
    app.unmount()
  }
  return {
    ready,
    removed,
    received,
    unmount,
    complete: () => resolveListen(handlerId),
    fail: () => rejectListen(new Error('subscription failed')),
    emit: (payload: string) => mockWindow.__TAURI_INTERNALS__.runCallback(handlerId, { payload }),
    cleanup() {
      unmount()
      clearMocks()
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    },
  }
}

test('unmount removes a subscription that finishes registering later', async () => {
  const fixture = createFixture()
  try {
    fixture.unmount()
    fixture.emit('late event before registration acknowledgement')
    assert.deepEqual(fixture.received, [])
    assert.deepEqual(fixture.removed, [])
    fixture.complete()
    await fixture.ready
    assert.equal(fixture.removed.length, 1)
  } finally {
    fixture.cleanup()
  }
})

test('a mounted subscription receives events and is removed once on unmount', async () => {
  const fixture = createFixture()
  try {
    fixture.complete()
    await fixture.ready
    fixture.emit('active event')
    assert.deepEqual(fixture.received, ['active event'])
    fixture.unmount()
    assert.equal(fixture.removed.length, 1)
  } finally {
    fixture.cleanup()
  }
})

test('failed registration still settles readiness after unmount', async () => {
  const fixture = createFixture()
  try {
    fixture.unmount()
    fixture.fail()
    await fixture.ready
    assert.deepEqual(fixture.removed, [])
  } finally {
    fixture.cleanup()
  }
})
