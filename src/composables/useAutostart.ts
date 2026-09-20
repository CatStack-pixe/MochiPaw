// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { invoke } from '@tauri-apps/api/core'
import { ref } from 'vue'

export interface AutostartAdapter {
  read: () => Promise<boolean>
  write: (enabled: boolean) => Promise<boolean>
}

const defaultAdapter: AutostartAdapter = {
  read: () => invoke<boolean>('get_autostart_enabled'),
  write: enabled => invoke<boolean>('set_autostart_enabled', { enabled }),
}

export function useAutostart(
  onEnabled: (enabled: boolean) => void,
  adapter = defaultAdapter,
) {
  const enabled = ref(false)
  const loading = ref(false)
  const ready = ref(false)

  function apply(value: boolean) {
    enabled.value = value
    onEnabled(value)
    ready.value = true
  }

  async function refresh() {
    if (loading.value) return

    loading.value = true
    try {
      // The operating system owns startup registration. Reading preferences
      // must never enable or disable it using a stale persisted boolean.
      apply(await adapter.read())
    } catch (error) {
      ready.value = false
      throw error
    } finally {
      loading.value = false
    }
  }

  async function setEnabled(value: boolean) {
    if (!ready.value || loading.value) return

    loading.value = true
    try {
      apply(await adapter.write(value))
    } catch (error) {
      // A registry operation can fail after a partial write. Show the actual
      // state if it is readable, keeping the original failure for the caller.
      try {
        apply(await adapter.read())
      } catch {
        ready.value = false
      }
      throw error
    } finally {
      loading.value = false
    }
  }

  return { enabled, loading, ready, refresh, setEnabled }
}
