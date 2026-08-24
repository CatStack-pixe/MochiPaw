// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import type { Ref } from 'vue'

import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { computed, onUnmounted, reactive, watch } from 'vue'

import type { ModelRuntimeOptions } from '@/composables/useModel'
import type { Model } from '@/stores/model'
import type { GamepadInputEvent } from '@/utils/subModelRuntime'

import { INVOKE_KEY, LISTEN_KEY } from '@/constants'
import { useModelStore } from '@/stores/model'
import { logError, logInfo } from '@/utils/diagnostics'
import live2d from '@/utils/live2d'

import { useModel } from './useModel'
import { useTauriListen } from './useTauriListen'

interface StickState {
  x: number
  y: number
  moved: boolean
  pressed: boolean
}

interface Sticks {
  left: StickState
  right: StickState
}

const INITIAL_STICK_STATE: StickState = { x: 0, y: 0, moved: false, pressed: false }
const appWindow = getCurrentWebviewWindow()

export interface UseGamepadOptions extends ModelRuntimeOptions {
  enabled?: Readonly<Ref<boolean>>
  currentModel?: Readonly<Ref<Model | undefined>>
  listen?: boolean
  nativeDemand?: Readonly<Ref<boolean>>
  onInputEvent?: (event: GamepadInputEvent) => void
}

export function useGamepad(options: UseGamepadOptions = {}) {
  const modelStore = useModelStore()
  const enabled = options.enabled ?? computed(() => true)
  const currentModel = options.currentModel ?? computed(() => modelStore.currentModel)
  const nativeDemand = computed(() => {
    return options.nativeDemand?.value || (enabled.value && currentModel.value?.mode === 'gamepad')
  })
  const { handlePress, handleRelease, handleAxisChange } = useModel(options)
  const sticks = reactive<Sticks>({
    left: { ...INITIAL_STICK_STATE },
    right: { ...INITIAL_STICK_STATE },
  })

  const stickActive = computed(() => ({
    left: sticks.left.moved || sticks.left.pressed,
    right: sticks.right.moved || sticks.right.pressed,
  }))

  const syncGamepadListener = (isEnabled: boolean) => {
    if (options.listen === false) return Promise.resolve()

    logInfo('[gamepad] syncing native listener', { windowLabel: appWindow.label, enabled: isEnabled, modelId: currentModel.value?.id })
    return invoke(INVOKE_KEY.SET_GAMEPAD_LISTENER_ENABLED, {
      windowLabel: appWindow.label,
      enabled: isEnabled,
    }).then(() => {
      logInfo('[gamepad] native listener synchronized', { windowLabel: appWindow.label, enabled: isEnabled })
    }).catch((error) => {
      logError('[gamepad] native listener synchronization failed', { windowLabel: appWindow.label, enabled: isEnabled, error })
      throw error
    })
  }

  watch(nativeDemand, (isEnabled) => {
    void syncGamepadListener(isEnabled).catch(() => undefined)
  }, { immediate: true })

  watch(enabled, (isEnabled) => {
    if (isEnabled) return

    Object.assign(sticks.left, INITIAL_STICK_STATE)
    Object.assign(sticks.right, INITIAL_STICK_STATE)

    for (const id of [
      'CatParamStickLX',
      'CatParamStickLY',
      'CatParamStickRX',
      'CatParamStickRY',
      'CatParamStickLeftDown',
      'CatParamStickRightDown',
      'CatParamStickShowLeftHand',
      'CatParamStickShowRightHand',
    ]) {
      live2d.setParameterValue(id, false)
    }
  }, { immediate: true })

  onUnmounted(() => {
    void syncGamepadListener(false).catch(() => undefined)
  })

  watch(sticks.left, ({ x, y, moved, pressed }) => {
    sticks.left.moved = x !== 0 || y !== 0

    live2d.setParameterValue('CatParamStickShowLeftHand', moved || pressed)
  }, { deep: true })

  watch(sticks.right, ({ x, y, moved, pressed }) => {
    sticks.right.moved = x !== 0 || y !== 0

    live2d.setParameterValue('CatParamStickShowRightHand', moved || pressed)
  }, { deep: true })

  const handleInputEvent = (payload: GamepadInputEvent) => {
    if (!enabled.value) return

    const { name, value } = payload

    switch (name) {
      case 'LeftStickX':
        sticks.left.x = value

        return handleAxisChange('CatParamStickLX', value)
      case 'LeftStickY':
        sticks.left.y = value

        return handleAxisChange('CatParamStickLY', value)
      case 'RightStickX':
        sticks.right.x = value

        return handleAxisChange('CatParamStickRX', value)
      case 'RightStickY':
        sticks.right.y = value

        return handleAxisChange('CatParamStickRY', value)
      case 'LeftThumb':
        sticks.left.pressed = value !== 0

        return live2d.setParameterValue('CatParamStickLeftDown', value !== 0)
      case 'RightThumb':
        sticks.right.pressed = value !== 0

        return live2d.setParameterValue('CatParamStickRightDown', value !== 0)
      default:
        return value > 0 ? handlePress(name) : handleRelease(name)
    }
  }

  if (options.listen !== false) {
    useTauriListen<GamepadInputEvent>(LISTEN_KEY.GAMEPAD_CHANGED, ({ payload }) => {
      handleInputEvent(payload)
      options.onInputEvent?.(payload)
    })
  }

  return {
    handleInputEvent,
    stickActive,
  }
}
