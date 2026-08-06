// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ShortcutHandler } from '@tauri-apps/plugin-global-shortcut'

import { register, unregister } from '@tauri-apps/plugin-global-shortcut'

export interface ShortcutAdapter {
  register: (shortcut: string, handler: ShortcutHandler) => Promise<void>
  unregister: (shortcut: string) => Promise<void>
}

interface ShortcutBinding {
  shortcut: string
  handler: ShortcutHandler
}

export class ShortcutConflictError extends Error {
  readonly shortcut: string

  constructor(shortcut: string) {
    super(`The shortcut is already assigned: ${shortcut}`)
    this.name = 'ShortcutConflictError'
    this.shortcut = shortcut
  }
}

export class ShortcutRegistry {
  private readonly bindings = new Map<symbol, ShortcutBinding>()
  private readonly owners = new Map<string, symbol>()
  private queue = Promise.resolve()

  constructor(private readonly adapter: ShortcutAdapter) {}

  update(owner: symbol, shortcut: string | undefined, handler: ShortcutHandler) {
    return this.enqueue(async () => {
      const nextShortcut = shortcut || undefined
      const current = this.bindings.get(owner)

      if (current && current.shortcut === nextShortcut) {
        current.handler = handler
        return
      }

      if (nextShortcut) {
        const currentOwner = this.owners.get(nextShortcut)

        if (currentOwner && currentOwner !== owner) {
          throw new ShortcutConflictError(nextShortcut)
        }

        await this.adapter.register(nextShortcut, handler)
      }

      if (current) {
        try {
          await this.adapter.unregister(current.shortcut)
        } catch (error) {
          if (nextShortcut) {
            await this.adapter.unregister(nextShortcut).catch(() => undefined)
          }

          throw error
        }

        this.owners.delete(current.shortcut)
      }

      if (!nextShortcut) {
        this.bindings.delete(owner)
        return
      }

      this.owners.set(nextShortcut, owner)
      this.bindings.set(owner, {
        shortcut: nextShortcut,
        handler,
      })
    })
  }

  release(owner: symbol) {
    return this.enqueue(async () => {
      const current = this.bindings.get(owner)

      if (!current) return

      await this.adapter.unregister(current.shortcut)
      this.owners.delete(current.shortcut)
      this.bindings.delete(owner)
    })
  }

  private enqueue<T>(operation: () => Promise<T>) {
    const next = this.queue.then(operation, operation)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }
}

export const shortcutRegistry = new ShortcutRegistry({
  register,
  unregister,
})
