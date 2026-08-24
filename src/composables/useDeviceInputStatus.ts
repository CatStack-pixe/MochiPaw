// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { invoke } from '@tauri-apps/api/core'
import { onMounted, ref } from 'vue'

import { INVOKE_KEY } from '@/constants'
import { logError, logInfo } from '@/utils/diagnostics'

export interface DeviceInputStatus {
  backend: 'rdev' | 'wayland-service' | 'wayland-appimage'
  available: boolean
  authorized: boolean
  hoverSupported: boolean
  error?: string
}

export function useDeviceInputStatus() {
  const status = ref<DeviceInputStatus>()

  const refresh = async () => {
    try {
      status.value = await invoke<DeviceInputStatus>(INVOKE_KEY.GET_DEVICE_INPUT_STATUS)
      logInfo('[device-status] refreshed', { ...status.value })
    } catch (error) {
      logError('[device-status] refresh failed', { error })
      throw error
    }
    return status.value
  }

  onMounted(() => {
    void refresh().catch(() => undefined)
  })

  return { status, refresh }
}
