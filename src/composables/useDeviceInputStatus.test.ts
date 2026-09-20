import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import type { DeviceInputStatus } from './useDeviceInputStatus'

import { createDeviceInputStatusController } from './useDeviceInputStatus'

const unavailable: DeviceInputStatus = {
  backend: 'wayland-evdev',
  available: false,
  authorized: false,
  hoverSupported: false,
  error: 'Permission denied: /dev/input/event0',
}
const available: DeviceInputStatus = {
  backend: 'wayland-evdev',
  available: true,
  authorized: true,
  hoverSupported: false,
}

test('status polling observes access changes without starting a listener', async () => {
  let current = unavailable
  const controller = createDeviceInputStatusController({
    read: async () => current,
    start: async () => assert.fail('polling must not start input capture'),
  })
  await controller.refresh()
  assert.equal(controller.status.value?.error, unavailable.error)
  current = available
  await controller.refresh()
  assert.equal(controller.status.value?.available, true)
  assert.equal(controller.status.value?.hoverSupported, false)
})

test('retry waits for startup and prevents concurrent polling and duplicate starts', async () => {
  let complete!: () => void
  let reads = 0
  let starts = 0
  const controller = createDeviceInputStatusController({
    read: async () => {
      reads++
      return available
    },
    start: () => {
      starts++
      return new Promise<void>((resolve) => {
        complete = resolve
      })
    },
  })
  const pending = controller.retry()
  await controller.retry()
  await controller.refresh()
  assert.equal(controller.retrying.value, true)
  assert.equal(reads, 0)
  complete()
  await pending
  await controller.retry()
  assert.equal(starts, 1)
  assert.equal(reads, 1)
  assert.equal(controller.retrying.value, false)
  assert.equal(controller.status.value?.available, true)
})

test('failed retry reads back backend details and remains retryable after a permission fix', async () => {
  let fixed = false
  const controller = createDeviceInputStatusController({
    read: async () => fixed ? available : unavailable,
    start: async () => {
      if (!fixed) throw new Error('input access denied')
    },
  })
  await assert.rejects(controller.retry(), /input access denied/)
  assert.equal(controller.error.value, 'input access denied')
  assert.equal(controller.status.value?.error, unavailable.error)
  assert.equal(controller.retrying.value, false)
  fixed = true
  await controller.retry()
  assert.equal(controller.status.value?.available, true)
  assert.equal(controller.error.value, '')
})

test('a failed status request surfaces the failure and clears it after recovery', async () => {
  let readable = false
  const controller = createDeviceInputStatusController({
    read: async () => {
      if (!readable) throw new Error('status request failed')
      return available
    },
    start: async () => {},
  })
  await assert.rejects(controller.refresh(), /status request failed/)
  assert.equal(controller.error.value, 'status request failed')
  assert.equal(controller.refreshing.value, false)
  readable = true
  await controller.refresh()
  assert.equal(controller.error.value, '')
  assert.equal(controller.status.value?.available, true)
})
