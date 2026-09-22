// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import type { TestContext } from 'node:test'

import { emit } from '@tauri-apps/api/event'
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import { it } from 'node:test'

import type { SubModelInstance } from '@/stores/model'

import { LISTEN_KEY } from '@/constants'

import { destroySubModelWindow, getSubModelWindowLabel, hideSubModelWindow, openSubModelWindow } from './subModelWindow'

const instance: SubModelInstance = {
  id: 'test-instance',
  modelId: 'test-model',
  visible: true,
  showOnLaunch: false,
  createdAt: 1,
  listeners: { keyboard: false, mouse: false, gamepad: false, typingBehavior: false },
  window: { x: -100, y: 200, scale: 1, opacity: 1, radius: 0, passThrough: false, alwaysOnTop: true },
  appearance: { mirror: false, mouseMirror: false, mouseMirrorY: false, maxFPS: 60 },
}

function mockRuntime(context: TestContext, os: string, options: {
  beforeCreate?: () => Promise<void>
  announceReady?: boolean
} = {}) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { crypto: globalThis.crypto, __TAURI_OS_PLUGIN_INTERNALS__: { platform: os } },
  })
  context.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })

  let exists = false
  const calls: Array<{ command: string, args: Record<string, unknown> }> = []
  mockIPC(async (command, args) => {
    calls.push({ command, args: args as Record<string, unknown> })
    if (command === 'plugin:window|get_all_windows') {
      return exists ? [getSubModelWindowLabel(instance.id)] : []
    }
    if (command === 'create_sub_model_window' || command === 'plugin:webview|create_webview_window') {
      await options.beforeCreate?.()
      exists = true
      if (options.announceReady !== false) {
        // Deliberately announce before the creation command returns: listeners
        // must be installed already, including for Rust-created webviews.
        await emit(LISTEN_KEY.SUB_MODEL_RUNTIME_READY, { id: instance.id })
      }
    }
    if (command === 'plugin:window|destroy') exists = false
  }, { shouldMockEvents: true })

  return calls
}

it('builds the stable submodel window label', () => {
  assert.equal(getSubModelWindowLabel('test-instance'), 'sub-model-test-instance')
})

it('creates Windows submodels natively without requiring a JavaScript created event', async (context) => {
  const calls = mockRuntime(context, 'windows')

  const window = await openSubModelWindow(instance)

  assert.equal(window?.label, 'sub-model-test-instance')
  assert.deepEqual(calls.find(call => call.command === 'create_sub_model_window')?.args, {
    instanceId: instance.id,
    x: -100,
    y: 200,
    alwaysOnTop: true,
  })
  assert.equal(calls.some(call => call.command === 'plugin:webview|create_webview_window'), false)
  assert.equal(calls.some(call => call.command === 'plugin:window|show'), true)
})

it('retains the normal webview constructor on other platforms', async (context) => {
  const calls = mockRuntime(context, 'linux')

  const window = await openSubModelWindow(instance)

  assert.equal(window?.label, 'sub-model-test-instance')
  const options = calls.find(call => call.command === 'plugin:webview|create_webview_window')?.args.options
  assert.equal((options as { url: string }).url, 'index.html/#/sub-model?instance=test-instance')
  assert.equal(Object.keys(options as object).includes('dataDirectory'), false)
  assert.equal(calls.some(call => call.command === 'create_sub_model_window'), false)
})

it('propagates native creation failures without using a default-directory fallback', async (context) => {
  const calls = mockRuntime(context, 'windows', {
    beforeCreate: async () => {
      throw new Error('Data directory is not writable')
    },
  })

  await assert.rejects(openSubModelWindow(instance), /Data directory is not writable/)
  assert.equal(calls.some(call => call.command === 'plugin:webview|create_webview_window'), false)
  assert.equal(calls.some(call => call.command === 'plugin:window|show'), false)
})

it('destroys hidden Windows webviews when runtime initialization times out', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = mockRuntime(context, 'windows', { announceReady: false })
  const rejected = assert.rejects(openSubModelWindow(instance), /Timed out/)
  await new Promise(resolve => setImmediate(resolve))

  context.mock.timers.tick(10_001)
  await rejected

  assert.equal(calls.some(call => call.command === 'plugin:window|destroy'), true)
  assert.equal(calls.some(call => call.command === 'plugin:window|show'), false)
})

it('destroys native windows that finish creation after initialization timed out', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let finishCreation!: () => void
  const calls = mockRuntime(context, 'windows', {
    beforeCreate: () => new Promise<void>((resolve) => {
      finishCreation = resolve
    }),
    announceReady: false,
  })
  const rejected = assert.rejects(openSubModelWindow(instance), /Timed out/)
  await new Promise(resolve => setImmediate(resolve))
  context.mock.timers.tick(10_001)
  await rejected

  finishCreation()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(calls.some(call => call.command === 'plugin:window|destroy'), true)
  assert.equal(calls.some(call => call.command === 'plugin:window|show'), false)
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve }
}

function installMockIPC() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { crypto: globalThis.crypto },
  })
  mockWindows('preference')
  mockIPC(() => null)
  return () => {
    clearMocks()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

function createInstance(): SubModelInstance {
  return {
    id: 'pet',
    modelId: 'model',
    visible: true,
    showOnLaunch: true,
    createdAt: 0,
    listeners: { keyboard: true, mouse: true, gamepad: true, typingBehavior: true },
    window: { scale: 100, opacity: 100, radius: 0, passThrough: false, alwaysOnTop: false },
    appearance: { mirror: false, mouseMirror: false, mouseMirrorY: false, maxFPS: 60 },
  }
}

function fakeWindow(overrides: { show?: () => Promise<void>, destroy?: () => Promise<void> } = {}) {
  return {
    setAlwaysOnTop: async () => {},
    setIgnoreCursorEvents: async () => {},
    setFocus: async () => {},
    show: async () => {},
    destroy: async () => {},
    ...overrides,
  } as unknown as WebviewWindow
}

it('hide and destroy wait for an in-flight open operation', async (context) => {
  const restore = installMockIPC()
  const showing = deferred()
  const allowShow = deferred()
  const events: string[] = []
  const window = fakeWindow({
    show: async () => {
      events.push('show')
      showing.resolve()
      await allowShow.promise
    },
    destroy: async () => { events.push('destroy') },
  })
  context.mock.method(WebviewWindow, 'getByLabel', async () => window)
  try {
    const opened = openSubModelWindow(createInstance())
    const hidden = hideSubModelWindow('pet')
    const deleted = destroySubModelWindow('pet')
    await showing.promise
    assert.deepEqual(events, ['show'])
    allowShow.resolve()
    await Promise.all([opened, hidden, deleted])
    assert.deepEqual(events, ['show', 'destroy', 'destroy'])
  } finally {
    allowShow.resolve()
    restore()
  }
})

it('a new open waits for an in-flight destroy operation', async (context) => {
  const restore = installMockIPC()
  const destroying = deferred()
  const allowDestroy = deferred()
  const events: string[] = []
  const window = fakeWindow({
    show: async () => { events.push('show') },
    destroy: async () => {
      events.push('destroy')
      destroying.resolve()
      await allowDestroy.promise
    },
  })
  context.mock.method(WebviewWindow, 'getByLabel', async () => window)
  try {
    const hidden = hideSubModelWindow('pet')
    const opened = openSubModelWindow(createInstance())
    await destroying.promise
    assert.deepEqual(events, ['destroy'])
    allowDestroy.resolve()
    await Promise.all([hidden, opened])
    assert.deepEqual(events, ['destroy', 'show'])
  } finally {
    allowDestroy.resolve()
    restore()
  }
})

it('a failed destroy does not poison subsequent window operations', async (context) => {
  const restore = installMockIPC()
  let shown = false
  const window = fakeWindow({
    destroy: async () => { throw new Error('destroy failed') },
    show: async () => { shown = true },
  })
  context.mock.method(WebviewWindow, 'getByLabel', async () => window)
  try {
    const deleted = destroySubModelWindow('pet')
    const opened = openSubModelWindow(createInstance())
    await assert.rejects(deleted, /destroy failed/)
    await opened
    assert.equal(shown, true)
  } finally {
    restore()
  }
})

it('rejects timed-out creation promptly and reserves only its label until late cleanup', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const allowCreation = deferred()
  let creationCount = 0
  const options = {
    beforeCreate: async () => {
      creationCount += 1
      if (creationCount === 1) await allowCreation.promise
    },
    announceReady: false,
  }
  const calls = mockRuntime(context, 'windows', options)
  const originalLookup = WebviewWindow.getByLabel.bind(WebviewWindow)
  const otherWindow = fakeWindow()
  context.mock.method(WebviewWindow, 'getByLabel', async (label: string) => {
    return label === 'sub-model-other' ? otherWindow : originalLookup(label)
  })

  const rejected = assert.rejects(openSubModelWindow(instance), /Timed out/)
  await new Promise(resolve => setImmediate(resolve))
  context.mock.timers.tick(10_001)
  await rejected

  await assert.rejects(openSubModelWindow(instance), /still finishing an earlier creation/)
  assert.equal(creationCount, 1)
  // Close requests for the timed-out label leave teardown to its creator.
  await hideSubModelWindow(instance.id)
  await destroySubModelWindow(instance.id)
  assert.equal(calls.filter(call => call.command === 'plugin:window|destroy').length, 0)
  // A hung native creation does not prevent operations on another label.
  await openSubModelWindow({ ...createInstance(), id: 'other' })

  allowCreation.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.filter(call => call.command === 'plugin:window|destroy').length, 1)

  options.announceReady = true
  await openSubModelWindow(instance)
  assert.equal(creationCount, 2)
  assert.equal(calls.filter(call => call.command === 'plugin:window|destroy').length, 1)
})
