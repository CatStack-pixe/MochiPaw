import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Project tests use the Node test runner through tsx.
import test from 'node:test'

import { setWebviewMemoryTarget } from './window'

test('unsupported platforms skip native memory-target IPC and logging', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const os = { platform: 'linux' }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { crypto: globalThis.crypto, __TAURI_OS_PLUGIN_INTERNALS__: os },
  })
  mockWindows('main')
  const commands: string[] = []
  mockIPC((command) => {
    commands.push(command)
    return true
  })
  try {
    for (const platform of ['linux', 'macos']) {
      os.platform = platform
      assert.equal(await setWebviewMemoryTarget('low'), false)
      assert.equal(await setWebviewMemoryTarget('normal'), false)
    }
    assert.equal(commands.length, 0)
    os.platform = 'windows'
    assert.equal(await setWebviewMemoryTarget('normal'), true)
    assert.ok(commands.includes('plugin:custom-window|set_webview_memory_target'))
  } finally {
    clearMocks()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
