import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { useAutostart } from './useAutostart'

test('reads the OS state without rewriting startup registration on mount', async () => {
  let persisted = true
  const controller = useAutostart(value => persisted = value, {
    read: async () => false,
    write: async () => {
      throw new Error('unexpected write')
    },
  })

  await controller.refresh()

  assert.equal(controller.ready.value, true)
  assert.equal(controller.enabled.value, false)
  assert.equal(persisted, false)
})

test('waits for registration and rejects concurrent toggle attempts', async () => {
  let complete!: (value: boolean) => void
  const writes: boolean[] = []
  const persisted: boolean[] = []
  const controller = useAutostart(value => persisted.push(value), {
    read: async () => false,
    write: value => new Promise<boolean>((resolve) => {
      writes.push(value)
      complete = resolve
    }),
  })
  await controller.refresh()
  const pending = controller.setEnabled(true)
  await controller.setEnabled(false)

  assert.equal(controller.loading.value, true)
  assert.equal(controller.enabled.value, false)
  assert.deepEqual(persisted, [false])
  complete(true)
  await pending

  assert.deepEqual(writes, [true])
  assert.deepEqual(persisted, [false, true])
  assert.equal(controller.loading.value, false)
})

test('refresh after returning to preferences observes external startup changes', async () => {
  let systemEnabled = true
  const persisted: boolean[] = []
  const controller = useAutostart(value => persisted.push(value), {
    read: async () => systemEnabled,
    write: async () => {
      throw new Error('refresh must not overwrite external changes')
    },
  })
  await controller.refresh()
  systemEnabled = false
  await controller.refresh()

  assert.equal(controller.enabled.value, false)
  assert.deepEqual(persisted, [true, false])
})

test('failed enable restores the OS state and allows a later retry', async () => {
  let fail = true
  const controller = useAutostart(() => {}, {
    read: async () => false,
    write: async (value) => {
      if (fail) throw new Error('access denied')
      return value
    },
  })
  await controller.refresh()
  await assert.rejects(controller.setEnabled(true), /access denied/)

  assert.equal(controller.enabled.value, false)
  assert.equal(controller.loading.value, false)
  fail = false
  await controller.setEnabled(true)
  assert.equal(controller.enabled.value, true)
})

test('reads back a partially applied change instead of showing stale success', async () => {
  let actual = false
  let persisted = false
  const controller = useAutostart(value => persisted = value, {
    read: async () => actual,
    write: async () => {
      actual = true
      throw new Error('readback failed')
    },
  })
  await controller.refresh()
  await assert.rejects(controller.setEnabled(true), /readback failed/)
  assert.equal(controller.enabled.value, true)
  assert.equal(persisted, true)
})

test('an unreadable OS state blocks writes until refresh succeeds', async () => {
  let fail = true
  const controller = useAutostart(() => {}, {
    read: async () => {
      if (fail) throw new Error('registry unavailable')
      return false
    },
    write: async () => {
      throw new Error('unexpected write')
    },
  })
  await assert.rejects(controller.refresh(), /registry unavailable/)
  await controller.setEnabled(true)
  assert.equal(controller.ready.value, false)
  assert.equal(controller.loading.value, false)
  fail = false
  await controller.refresh()
  assert.equal(controller.ready.value, true)
})
