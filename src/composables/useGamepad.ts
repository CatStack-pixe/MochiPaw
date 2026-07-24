// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import type { LiteralUnion } from 'type-fest'
import type { Ref } from 'vue'

import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { computed, onUnmounted, reactive, watch } from 'vue'

import type { ModelRuntimeOptions } from '@/composables/useModel'
import type { Model } from '@/stores/model'

import { INVOKE_KEY, LISTEN_KEY } from '@/constants'
import { useModelStore } from '@/stores/model'
import live2d from '@/utils/live2d'

import { useModel } from './useModel'
import { useTauriListen } from './useTauriListen'

type GamepadEventName = LiteralUnion<'LeftStickX' | 'LeftStickY' | 'RightStickX' | 'RightStickY' | 'LeftThumb' | 'RightThumb', string>

interface GamepadEvent {
  kind: 'ButtonChanged' | 'AxisChanged'
  name: GamepadEventName
  value: number
}

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
}

export function useGamepad(options: UseGamepadOptions = {}) {
  const modelStore = useModelStore()
  const enabled = options.enabled ?? computed(() => true)
  const currentModel = options.currentModel ?? computed(() => modelStore.currentModel)
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
    return invoke(INVOKE_KEY.SET_GAMEPAD_LISTENER_ENABLED, {
      windowLabel: appWindow.label,
      enabled: isEnabled && currentModel.value?.mode === 'gamepad',
    })
  }

  watch([enabled, currentModel], ([isEnabled]) => {
    void syncGamepadListener(isEnabled)
  }, { immediate: true })

  onUnmounted(() => {
    void syncGamepadListener(false)
  })

  watch(sticks.left, ({ x, y, moved, pressed }) => {
    sticks.left.moved = x !== 0 || y !== 0

    live2d.setParameterValue('CatParamStickShowLeftHand', moved || pressed)
  }, { deep: true })

  watch(sticks.right, ({ x, y, moved, pressed }) => {
    sticks.right.moved = x !== 0 || y !== 0

    live2d.setParameterValue('CatParamStickShowRightHand', moved || pressed)
  }, { deep: true })

  useTauriListen<GamepadEvent>(LISTEN_KEY.GAMEPAD_CHANGED, ({ payload }) => {
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
  })

  return {
    stickActive,
  }
}
