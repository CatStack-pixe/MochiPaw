import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import type { SubModelInstance } from '@/stores/model'

import type { SubModelInputFrame, SubModelInputScheduler } from './subModelRuntime'

import { applySubModelInputFrame, MAX_PENDING_SUB_MODEL_INPUT_EVENTS, SubModelInputCoordinator } from './subModelRuntime'

class TestScheduler implements SubModelInputScheduler {
  private nextHandle = 1
  private callbacks = new Map<number, () => void>()
  requests = 0

  request(callback: () => void) {
    const handle = this.nextHandle++
    this.callbacks.set(handle, callback)
    this.requests += 1
    return handle
  }

  cancel(handle: number) {
    this.callbacks.delete(handle)
  }

  runNext() {
    const callback = this.callbacks.values().next().value as (() => void) | undefined
    if (!callback) return

    const handle = this.callbacks.keys().next().value as number
    this.callbacks.delete(handle)
    callback()
  }
}

function createInstance(
  id: string,
  listeners: Partial<SubModelInstance['listeners']> = {},
): SubModelInstance {
  return {
    id,
    modelId: 'model',
    visible: true,
    showOnLaunch: true,
    createdAt: 0,
    listeners: {
      keyboard: true,
      mouse: true,
      gamepad: true,
      typingBehavior: true,
      ...listeners,
    },
    window: {
      scale: 100,
      opacity: 100,
      radius: 0,
      passThrough: false,
      alwaysOnTop: false,
    },
    appearance: {
      mirror: false,
      mouseMirror: false,
      mouseMirrorY: false,
      maxFPS: 60,
    },
  }
}

async function runScheduled(scheduler: TestScheduler) {
  scheduler.runNext()
  // The coordinator deliberately does not block the scheduler callback on IPC.
  await new Promise(resolve => setImmediate(resolve))
}

test('does not schedule input when no visible sub-model can receive it', () => {
  const scheduler = new TestScheduler()
  const coordinator = new SubModelInputCoordinator(() => [], { scheduler })

  coordinator.enqueueDevice({ kind: 'KeyboardPress', value: 'A' })
  coordinator.enqueueGamepad({ kind: 'ButtonChanged', name: 'South', value: 1 })

  assert.equal(scheduler.requests, 0)
  assert.equal(coordinator.getPendingEventCount(), 0)
})

test('filters device and gamepad events by each instance listener set', async () => {
  const scheduler = new TestScheduler()
  const keyboardOnly = createInstance('keyboard', { mouse: false, gamepad: false })
  const mouseOnly = createInstance('mouse', { keyboard: false, gamepad: false })
  const gamepadOnly = createInstance('gamepad', { keyboard: false, mouse: false })
  const sent: Array<{ id: string, frame: SubModelInputFrame }> = []
  const coordinator = new SubModelInputCoordinator(
    () => [keyboardOnly, mouseOnly, gamepadOnly],
    {
      scheduler,
      send: (instance, frame) => sent.push({ id: instance.id, frame }),
    },
  )

  coordinator.enqueueDevice({ kind: 'KeyboardPress', value: 'A' })
  coordinator.enqueueDevice({ kind: 'MousePress', value: 'Left' })
  coordinator.enqueueGamepad({ kind: 'ButtonChanged', name: 'South', value: 1 })
  await runScheduled(scheduler)

  assert.deepEqual(sent.map(({ id, frame }) => [id, frame.deviceEvents.length, frame.gamepadEvents.length]), [
    ['keyboard', 1, 0],
    ['mouse', 1, 0],
    ['gamepad', 0, 1],
  ])
})

test('keeps button press/release edges while coalescing axis values', async () => {
  const scheduler = new TestScheduler()
  const instance = createInstance('gamepad')
  const sent: SubModelInputFrame[] = []
  const coordinator = new SubModelInputCoordinator(() => [instance], {
    scheduler,
    send: (_instance, frame) => sent.push(frame),
  })

  coordinator.enqueueGamepad({ kind: 'ButtonChanged', name: 'South', value: 1 })
  coordinator.enqueueGamepad({ kind: 'ButtonChanged', name: 'South', value: 0 })
  coordinator.enqueueGamepad({ kind: 'AxisChanged', name: 'LeftStickX', value: 0.25 })
  coordinator.enqueueGamepad({ kind: 'AxisChanged', name: 'LeftStickX', value: 0.75 })
  await runScheduled(scheduler)

  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].gamepadEvents, [
    { kind: 'ButtonChanged', name: 'South', value: 1 },
    { kind: 'ButtonChanged', name: 'South', value: 0 },
    { kind: 'AxisChanged', name: 'LeftStickX', value: 0.75 },
  ])
})

test('bounds events retained while a hidden-window frame is throttled', () => {
  const scheduler = new TestScheduler()
  const instance = createInstance('keyboard', { mouse: false, gamepad: false })
  const coordinator = new SubModelInputCoordinator(() => [instance], {
    scheduler,
    maxPendingEvents: MAX_PENDING_SUB_MODEL_INPUT_EVENTS,
  })

  for (let index = 0; index < MAX_PENDING_SUB_MODEL_INPUT_EVENTS + 40; index += 1) {
    coordinator.enqueueDevice({ kind: 'KeyboardPress', value: `Key${index}` })
  }

  assert.equal(scheduler.requests, 1)
  assert.equal(coordinator.getPendingEventCount(), MAX_PENDING_SUB_MODEL_INPUT_EVENTS)
  assert.equal(coordinator.getDroppedEventCount(), 40)
})

test('dispose cancels a scheduled frame and drops queued events', () => {
  const scheduler = new TestScheduler()
  const instance = createInstance('keyboard')
  const coordinator = new SubModelInputCoordinator(() => [instance], { scheduler })

  coordinator.enqueueDevice({ kind: 'KeyboardPress', value: 'A' })
  coordinator.dispose()
  scheduler.runNext()

  assert.equal(coordinator.getPendingEventCount(), 0)
  assert.equal(scheduler.requests, 1)
})

test('timer fallback delivers input when animation frames are suspended', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const previousRaf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: () => 1,
  })
  const sent: SubModelInputFrame[] = []
  const instance = createInstance('keyboard')
  const coordinator = new SubModelInputCoordinator(() => [instance], {
    send: (_instance, frame) => sent.push(frame),
  })
  try {
    coordinator.enqueueDevice({ kind: 'KeyboardPress', value: 'A' })
    context.mock.timers.tick(100)
    await Promise.resolve()
    assert.equal(sent.length, 1)
    assert.equal(coordinator.getPendingEventCount(), 0)
  } finally {
    coordinator.dispose()
    if (previousRaf) Object.defineProperty(globalThis, 'requestAnimationFrame', previousRaf)
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame')
  }
})

test('slow IPC keeps one frame in flight and resumes the bounded pending queue', async () => {
  const scheduler = new TestScheduler()
  const instance = createInstance('keyboard')
  const sent: SubModelInputFrame[] = []
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const coordinator = new SubModelInputCoordinator(() => [instance], {
    scheduler,
    maxPendingEvents: 3,
    send: (_instance, frame) => {
      sent.push(frame)
      return pending
    },
  })
  coordinator.enqueueDevice({ kind: 'KeyboardPress', value: 'A' })
  await runScheduled(scheduler)
  for (let index = 0; index < 10; index += 1) {
    coordinator.enqueueDevice({ kind: 'KeyboardRelease', value: `Key${index}` })
  }
  assert.equal(scheduler.requests, 1)
  assert.equal(sent.length, 1)
  assert.equal(coordinator.getPendingEventCount(), 3)

  finish()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scheduler.requests, 2)
  await runScheduled(scheduler)
  assert.equal(sent.length, 2)
  assert.equal(sent[1].resetInputs, true)
  assert.equal(coordinator.getPendingEventCount(), 0)
  coordinator.dispose()
})

test('overflow resets previously delivered presses and axes before replaying the retained tail', async () => {
  const scheduler = new TestScheduler()
  const instance = createInstance('all-inputs')
  const mouseOnly = createInstance('mouse-only', { keyboard: false, gamepad: false })
  const sent: Array<{ id: string, frame: SubModelInputFrame }> = []
  const held = new Set<string>()
  let axis = 0
  let resets = 0
  const coordinator = new SubModelInputCoordinator(() => [instance, mouseOnly], {
    scheduler,
    maxPendingEvents: 3,
    send: (target, frame) => {
      sent.push({ id: target.id, frame })
      if (target.id !== instance.id) return
      applySubModelInputFrame(frame, {
        resetInputs: () => {
          resets += 1
          held.clear()
          axis = 0
        },
        handleDevice: (event) => {
          if (event.kind === 'MousePress') held.add(`mouse:${event.value}`)
          if (event.kind === 'MouseRelease') held.delete(`mouse:${event.value}`)
          if (event.kind === 'KeyboardPress') held.add(`key:${event.value}`)
          if (event.kind === 'KeyboardRelease') held.delete(`key:${event.value}`)
        },
        handleGamepad: (event) => {
          if (event.kind === 'AxisChanged') axis = event.value
          else if (event.value > 0) held.add(`pad:${event.name}`)
          else held.delete(`pad:${event.name}`)
        },
      })
    },
  })

  coordinator.enqueueDevice({ kind: 'MousePress', value: 'Left' })
  coordinator.enqueueDevice({ kind: 'KeyboardPress', value: 'A' })
  await runScheduled(scheduler)
  coordinator.enqueueGamepad({ kind: 'ButtonChanged', name: 'South', value: 1 })
  coordinator.enqueueGamepad({ kind: 'AxisChanged', name: 'LeftStickX', value: 0.75 })
  await runScheduled(scheduler)
  assert.deepEqual([...held], ['mouse:Left', 'key:A', 'pad:South'])
  assert.equal(axis, 0.75)

  coordinator.enqueueDevice({ kind: 'MouseRelease', value: 'Left' })
  coordinator.enqueueDevice({ kind: 'KeyboardRelease', value: 'A' })
  coordinator.enqueueGamepad({ kind: 'ButtonChanged', name: 'South', value: 0 })
  coordinator.enqueueGamepad({ kind: 'AxisChanged', name: 'LeftStickX', value: 0 })
  for (let index = 0; index < 4; index += 1) {
    coordinator.enqueueGamepad({ kind: 'ButtonChanged', name: 'East', value: 1 })
    coordinator.enqueueGamepad({ kind: 'ButtonChanged', name: 'East', value: 0 })
  }
  await runScheduled(scheduler)

  assert.equal(resets, 1)
  assert.equal(held.size, 0)
  assert.equal(axis, 0)
  const resetOnly = [...sent].reverse().find(item => item.id === mouseOnly.id)?.frame
  assert.equal(resetOnly?.resetInputs, true)
  assert.deepEqual(resetOnly?.deviceEvents, [])
  assert.deepEqual(resetOnly?.gamepadEvents, [])

  coordinator.enqueueDevice({ kind: 'KeyboardPress', value: 'B' })
  await runScheduled(scheduler)
  assert.equal(resets, 1)
  assert.deepEqual([...held], ['key:B'])
})
