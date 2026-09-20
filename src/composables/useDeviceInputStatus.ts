// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { INVOKE_KEY } from '@/constants'
import { logError, logInfo } from '@/utils/diagnostics'

export interface DeviceInputStatus {
  backend: 'rdev' | 'windows-raw-input' | 'wayland-service' | 'wayland-evdev'
  available: boolean
  authorized: boolean
  hoverSupported: boolean
  error?: string
}

interface DeviceInputAdapter {
  read: () => Promise<DeviceInputStatus>
  start: () => Promise<unknown>
}

const defaultAdapter: DeviceInputAdapter = {
  read: () => invoke<DeviceInputStatus>(INVOKE_KEY.GET_DEVICE_INPUT_STATUS),
  start: () => invoke(INVOKE_KEY.START_DEVICE_LISTENING),
}

export function createDeviceInputStatusController(adapter = defaultAdapter) {
  const status = ref<DeviceInputStatus>()
  const error = ref('')
  const refreshing = ref(false)
  const retrying = ref(false)

  async function readStatus() {
    const next = await adapter.read()
    if (JSON.stringify(next) !== JSON.stringify(status.value)) {
      logInfo('[device-status] changed', { ...next })
    }
    status.value = next
    error.value = ''
    return next
  }

  function reportError(cause: unknown) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    logError('[device-status] request failed', { error: cause })
  }

  async function refresh() {
    if (refreshing.value || retrying.value) return status.value

    refreshing.value = true
    try {
      return await readStatus()
    } catch (cause) {
      reportError(cause)
      throw cause
    } finally {
      refreshing.value = false
    }
  }

  async function retry() {
    if (refreshing.value || retrying.value || (status.value?.available && !error.value)) return

    retrying.value = true
    error.value = ''
    let failure: unknown
    try {
      try {
        await adapter.start()
      } catch (cause) {
        failure = cause
      }
      // Read the real backend state even when starting failed or only partially succeeded.
      try {
        await readStatus()
      } catch (cause) {
        failure ??= cause
      }
      if (failure !== undefined) {
        reportError(failure)
        throw failure
      }
    } finally {
      retrying.value = false
    }
  }

  return { status, error, refreshing, retrying, refresh, retry }
}

export function useDeviceInputStatus(options: { poll?: boolean } = {}) {
  const controller = createDeviceInputStatusController()
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false
  let checkingVisibility = false

  async function refreshVisible() {
    if (disposed || document.hidden || checkingVisibility) return

    checkingVisibility = true
    try {
      // Tauri hides and reuses preferences; DOM visibility alone may stay visible.
      if (await getCurrentWindow().isVisible() && !disposed) {
        await controller.refresh()
      }
    } catch (cause) {
      logError('[device-status] visible refresh failed', { error: cause })
    } finally {
      checkingVisibility = false
    }
  }

  function handleVisibility() {
    void refreshVisible()
  }

  onMounted(() => {
    void controller.refresh().catch(() => undefined)
    if (options.poll) {
      timer = setInterval(handleVisibility, 3000)
      window.addEventListener('focus', handleVisibility)
      document.addEventListener('visibilitychange', handleVisibility)
    }
  })

  onBeforeUnmount(() => {
    disposed = true
    if (timer !== undefined) clearInterval(timer)
    window.removeEventListener('focus', handleVisibility)
    document.removeEventListener('visibilitychange', handleVisibility)
  })

  return controller
}
