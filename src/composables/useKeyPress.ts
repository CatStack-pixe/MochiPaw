// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import type { ShortcutHandler } from '@tauri-apps/plugin-global-shortcut'
import type { Ref } from 'vue'

import { message } from '@tauri-apps/plugin-dialog'
import { onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { logError } from '@/utils/diagnostics'
import { ShortcutConflictError, shortcutRegistry } from '@/utils/shortcutRegistry'

export interface UseKeyPressOptions {
  enabled?: Ref<boolean>
}

export function useKeyPress(
  shortcut: Ref<string | undefined, string>,
  callback: ShortcutHandler,
  options: UseKeyPressOptions = {},
) {
  const owner = Symbol('shortcut-binding')
  const { t } = useI18n()
  let disposed = false
  let initialSync = true
  let registeredShortcut: string | undefined
  let lastAcceptedShortcut = normalizeShortcut(shortcut.value)
  let rollbackShortcut: string | null = null
  let syncGeneration = 0
  let isPressed = false

  const handleShortcut = (event: Parameters<ShortcutHandler>[0]) => {
    if (event.state === 'Released') {
      isPressed = false
      return
    }

    if (isPressed) return

    isPressed = true

    callback(event)
  }

  async function showRegistrationError(error: unknown, value: string) {
    const isConflict = error instanceof ShortcutConflictError
    const description = isConflict
      ? t('components.shortcut.hints.shortcutConflict', { shortcut: value })
      : t('components.shortcut.hints.shortcutRegistrationFailed')

    try {
      await message(description, {
        kind: 'error',
        title: t('components.shortcut.labels.shortcutRegistrationFailed'),
      })
    } catch (dialogError) {
      logError('[shortcut] failed to show registration error', { error: dialogError })
    }
  }

  async function syncShortcut(value: string, notifyOnError: boolean, generation: number) {
    try {
      if (disposed || generation !== syncGeneration) return

      await shortcutRegistry.update(owner, value || undefined, handleShortcut, {
        isCurrent: () => generation === syncGeneration && !disposed,
      })

      if (disposed || generation !== syncGeneration) return

      registeredShortcut = value || undefined
      lastAcceptedShortcut = value
      isPressed = false
    } catch (error) {
      if (generation !== syncGeneration) return

      logError('[shortcut] registration failed', {
        error,
        requestedShortcut: value,
        previousShortcut: lastAcceptedShortcut,
      })

      if (notifyOnError && !disposed && normalizeShortcut(shortcut.value) === value) {
        rollbackShortcut = lastAcceptedShortcut
        shortcut.value = lastAcceptedShortcut
        await showRegistrationError(error, value)
      }
    }
  }

  const stop = watch([shortcut, () => options.enabled?.value ?? true], ([value, enabled]) => {
    syncGeneration += 1

    if (!enabled) {
      void shortcutRegistry.update(owner, undefined, handleShortcut).catch((error: unknown) => {
        logError('[shortcut] failed to disable binding', { error })
      })
      return
    }

    const nextShortcut = normalizeShortcut(value)

    if (rollbackShortcut !== null && rollbackShortcut === nextShortcut) {
      rollbackShortcut = null
      return
    }

    const notifyOnError = !initialSync
    initialSync = false
    void syncShortcut(nextShortcut, notifyOnError, syncGeneration)
  }, { immediate: true })

  onUnmounted(() => {
    disposed = true
    stop()

    void shortcutRegistry.release(owner).then(() => {
      registeredShortcut = undefined
    }).catch((error: unknown) => {
      logError('[shortcut] failed to unregister', {
        error,
        shortcut: registeredShortcut,
      })
    })
  })
}

function normalizeShortcut(shortcut: string | undefined) {
  return shortcut?.trim() ?? ''
}
