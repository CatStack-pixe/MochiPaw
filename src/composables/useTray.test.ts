// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Project tests use the Node test runner through tsx.
import test from 'node:test'
import { createPinia } from 'pinia'
import { createRenderer, ref } from 'vue'
import { createI18n } from 'vue-i18n'

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

const settle = () => new Promise(resolve => setImmediate(resolve))

async function createFixture() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { crypto: globalThis.crypto, __TAURI_OS_PLUGIN_INTERNALS__: { platform: 'windows' } },
  })
  mockWindows('main')
  const roots: Array<{ rid: number, id: string }> = []
  const closed: number[] = []
  const installed: number[] = []
  let trayCreations = 0
  let failReplacement = false
  let holdReplacement: Promise<void> | undefined
  mockIPC(async (command, payload) => {
    const args = payload as Record<string, unknown>
    if (command === 'plugin:app|name') return 'test'
    if (command === 'plugin:app|version') return '1.0.0'
    if (command === 'plugin:menu|new') {
      assert.equal(args.kind, 'Menu', 'only roots should allocate resource handles')
      const options = args.options as { id: string }
      const root = { rid: roots.length + 1, id: options.id }
      roots.push(root)
      return [root.rid, root.id]
    }
    if (command === 'plugin:tray|get_by_id') return null
    if (command === 'plugin:tray|new') {
      trayCreations += 1
      installed.push(((args.options as { menu: [number, string] }).menu)[0])
      return [1000, 'BONGO_CAT_TRAY']
    }
    if (command === 'plugin:tray|set_menu') {
      await holdReplacement
      if (failReplacement) throw new Error('replacement failed')
      installed.push((args.menu as [number, string])[0])
    }
    if (command === 'plugin:resources|close') closed.push(args.rid as number)
    return null
  })
  const { useTray } = await import('./useTray')
  const { useCatStore } = await import('@/stores/cat')
  const pinia = createPinia()
  const app = renderer.createApp({
    setup() {
      useTray(ref(true))
      return () => null
    },
  })
  app.use(pinia)
  app.use(createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false }))
  app.mount({})
  await settle()
  let unmounted = false
  const unmount = () => {
    if (unmounted) return
    unmounted = true
    app.unmount()
  }
  return {
    roots,
    closed,
    installed,
    cat: useCatStore(pinia),
    trayCreations: () => trayCreations,
    failReplacement: (fail: boolean) => { failReplacement = fail },
    holdReplacement: (pending: Promise<void>) => { holdReplacement = pending },
    unmount,
    async cleanup() {
      unmount()
      await settle()
      clearMocks()
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    },
  }
}

test('tray replacements release old roots and retain one stable menu ID', async () => {
  const fixture = await createFixture()
  try {
    for (let index = 0; index < 5; index += 1) {
      fixture.cat.window.passThrough = !fixture.cat.window.passThrough
      await settle()
    }
    assert.equal(fixture.trayCreations(), 1)
    assert.equal(fixture.roots.length, 6)
    assert.equal(new Set(fixture.roots.map(root => root.id)).size, 1)
    assert.deepEqual(fixture.closed, [1, 2, 3, 4, 5])
    fixture.unmount()
    await settle()
    assert.deepEqual(fixture.closed, [1, 2, 3, 4, 5, 1000, 6])
  } finally {
    await fixture.cleanup()
  }
})

test('failed replacement keeps the installed menu and releases its candidate', async () => {
  const fixture = await createFixture()
  try {
    fixture.failReplacement(true)
    fixture.cat.window.passThrough = !fixture.cat.window.passThrough
    await settle()
    assert.deepEqual(fixture.installed, [1])
    assert.deepEqual(fixture.closed, [2])
    fixture.failReplacement(false)
    fixture.cat.window.passThrough = !fixture.cat.window.passThrough
    await settle()
    assert.deepEqual(fixture.installed, [1, 3])
    assert.deepEqual(fixture.closed, [2, 1])
  } finally {
    await fixture.cleanup()
  }
})

test('unmount waits for in-flight replacement before closing the tray and menu', async () => {
  const fixture = await createFixture()
  let finish!: () => void
  fixture.holdReplacement(new Promise<void>((resolve) => { finish = resolve }))
  try {
    fixture.cat.window.passThrough = !fixture.cat.window.passThrough
    await settle()
    fixture.unmount()
    assert.deepEqual(fixture.closed, [])
    finish()
    await settle()
    assert.deepEqual(fixture.closed, [1, 1000, 2])
  } finally {
    finish()
    await fixture.cleanup()
  }
})
