import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Project tests use the Node test runner through tsx.
import test from 'node:test'

import { FileLoader } from './FileLoader'

test('aborting while a response body is pending prevents a late buffer from escaping', async () => {
  const controller = new AbortController()
  let finish!: (buffer: ArrayBuffer) => void
  const body = new Promise<ArrayBuffer>((resolve) => { finish = resolve })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.signal, controller.signal)
    return { ok: true, arrayBuffer: () => body } as Response
  }
  try {
    const pending = FileLoader.fetchSafe('model.moc3', controller.signal)
    controller.abort()
    finish(new ArrayBuffer(64))
    await assert.rejects(pending, { name: 'AbortError' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a cancelled loader does not issue another resource request', async () => {
  const controller = new AbortController()
  controller.abort()
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests += 1
    throw new Error('Unexpected fetch')
  }
  try {
    await assert.rejects(FileLoader.fetchSafe('model.moc3', controller.signal), { name: 'AbortError' })
    assert.equal(requests, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
