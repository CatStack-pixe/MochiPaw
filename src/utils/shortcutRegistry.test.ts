import type { ShortcutHandler } from '@tauri-apps/plugin-global-shortcut'

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { ShortcutConflictError, ShortcutRegistry } from './shortcutRegistry'

const handler = (() => undefined) as ShortcutHandler

function createAdapter() {
  const registered = new Set<string>()
  const calls: string[] = []
  let activeOperations = 0
  let maxActiveOperations = 0
  let failingShortcut: string | undefined

  const adapter = {
    async register(shortcut: string, callback: ShortcutHandler) {
      void callback
      calls.push(`register:${shortcut}`)
      activeOperations += 1
      maxActiveOperations = Math.max(maxActiveOperations, activeOperations)
      await new Promise(resolve => setTimeout(resolve, 1))

      try {
        if (shortcut === failingShortcut) {
          throw new Error(`failed to register ${shortcut}`)
        }

        registered.add(shortcut)
      } finally {
        activeOperations -= 1
      }
    },
    async unregister(shortcut: string) {
      calls.push(`unregister:${shortcut}`)
      activeOperations += 1
      maxActiveOperations = Math.max(maxActiveOperations, activeOperations)
      await new Promise(resolve => setTimeout(resolve, 1))

      try {
        registered.delete(shortcut)
      } finally {
        activeOperations -= 1
      }
    },
  }

  return {
    adapter,
    calls,
    registered,
    get maxActiveOperations() {
      return maxActiveOperations
    },
    setFailingShortcut(value: string | undefined) {
      failingShortcut = value
    },
  }
}

test('replaces a binding only after the new shortcut is registered', async () => {
  const mock = createAdapter()
  const registry = new ShortcutRegistry(mock.adapter)
  const owner = Symbol('owner')

  await registry.update(owner, 'Control+A', handler)
  await registry.update(owner, 'Control+B', handler)

  assert.deepEqual([...mock.registered], ['Control+B'])
  assert.deepEqual(mock.calls, [
    'register:Control+A',
    'register:Control+B',
    'unregister:Control+A',
  ])
})

test('rejects a shortcut already owned by another binding', async () => {
  const mock = createAdapter()
  const registry = new ShortcutRegistry(mock.adapter)
  const firstOwner = Symbol('first-owner')
  const secondOwner = Symbol('second-owner')

  await registry.update(firstOwner, 'F1', handler)

  await assert.rejects(
    registry.update(secondOwner, 'F1', handler),
    error => error instanceof ShortcutConflictError && error.shortcut === 'F1',
  )

  assert.deepEqual([...mock.registered], ['F1'])
})

test('keeps the previous binding when the new registration fails', async () => {
  const mock = createAdapter()
  const registry = new ShortcutRegistry(mock.adapter)
  const owner = Symbol('owner')

  await registry.update(owner, 'F2', handler)
  mock.setFailingShortcut('F3')

  await assert.rejects(registry.update(owner, 'F3', handler), /failed to register F3/)

  assert.deepEqual([...mock.registered], ['F2'])
})

test('serializes concurrent binding updates', async () => {
  const mock = createAdapter()
  const registry = new ShortcutRegistry(mock.adapter)
  const firstOwner = Symbol('first-owner')
  const secondOwner = Symbol('second-owner')

  await Promise.all([
    registry.update(firstOwner, 'F4', handler),
    registry.update(secondOwner, 'F5', handler),
  ])

  assert.equal(mock.maxActiveOperations, 1)
  assert.deepEqual([...mock.registered].sort(), ['F4', 'F5'])
})
