// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

import {
  MOUSE_LOOK_SMOOTHING_DEFAULT,
  MOUSE_LOOK_WINDOW_RELATIVE_DEFAULT,
  normalizeMouseLookSmoothing,
} from '@/utils/mouseLookSmoothing'
import { MOUSE_SENSITIVITY_DEFAULT, normalizeMouseSensitivity } from '@/utils/mouseSensitivity'
import { persistStateWhenWritable } from '@/utils/persistence'

export interface CatStore {
  model: {
    mirror: boolean
    mouseMirror: boolean
    motionSound: boolean
    behavior: boolean
    typingExpression: boolean
    typingExpressionMinDelay: number
    typingExpressionMaxDelay: number
    typingBehaviorGroup: string
    autoReleaseDelay: number
    maxFPS: number
    ignoreMouse: boolean
    windowRelativeMouseLook: boolean
    mouseLookSmoothing: number
    legacyMouseLookSmoothing: number
    mouseSensitivity: number
  }
  window: {
    visible: boolean
    passThrough: boolean
    alwaysOnTop: boolean
    gameMode: {
      enabled: boolean
      processes: string[]
    }
    scale: number
    opacity: number
    radius: number
    hideOnHover: boolean
    hideOnHoverDelay: number
  }
}

export const useCatStore = defineStore('cat', () => {
  /* ------------ 废弃字段（后续删除） ------------ */

  /** @deprecated 请使用 `model.mirror` */
  const mirrorMode = ref(false)

  /** @deprecated 请使用 `model.mouseMirror` */
  const mouseMirror = ref(false)

  /** @deprecated 请使用 `window.passThrough` */
  const penetrable = ref(false)

  /** @deprecated 请使用 `window.alwaysOnTop` */
  const alwaysOnTop = ref(true)

  /** @deprecated 请使用 `window.scale` */
  const scale = ref(100)

  /** @deprecated 请使用 `window.opacity` */
  const opacity = ref(100)

  /** @deprecated 用于标识数据是否已迁移，后续版本将删除 */
  const migrated = ref(false)

  const model = reactive<CatStore['model']>({
    mirror: false,
    mouseMirror: false,
    motionSound: true,
    behavior: true,
    typingExpression: true,
    typingExpressionMinDelay: 18,
    typingExpressionMaxDelay: 30,
    typingBehaviorGroup: 'default',
    autoReleaseDelay: 3,
    maxFPS: 60,
    ignoreMouse: false,
    windowRelativeMouseLook: MOUSE_LOOK_WINDOW_RELATIVE_DEFAULT,
    mouseLookSmoothing: MOUSE_LOOK_SMOOTHING_DEFAULT,
    legacyMouseLookSmoothing: MOUSE_LOOK_SMOOTHING_DEFAULT,
    mouseSensitivity: MOUSE_SENSITIVITY_DEFAULT,
  })

  const window = reactive<CatStore['window']>({
    visible: true,
    passThrough: false,
    alwaysOnTop: false,
    gameMode: {
      enabled: false,
      processes: ['VALORANT-Win64-Shipping.exe', 'VALORANT.exe'],
    },
    scale: 100,
    opacity: 100,
    radius: 0,
    hideOnHover: false,
    hideOnHoverDelay: 0,
  })

  const init = () => {
    if (typeof model.windowRelativeMouseLook !== 'boolean') {
      model.windowRelativeMouseLook = MOUSE_LOOK_WINDOW_RELATIVE_DEFAULT
    }

    model.mouseLookSmoothing = normalizeMouseLookSmoothing(model.mouseLookSmoothing)
    model.legacyMouseLookSmoothing = normalizeMouseLookSmoothing(model.legacyMouseLookSmoothing)
    model.mouseSensitivity = normalizeMouseSensitivity(model.mouseSensitivity)

    if (!window.gameMode || !Array.isArray(window.gameMode.processes)) {
      window.gameMode = {
        enabled: false,
        processes: ['VALORANT-Win64-Shipping.exe', 'VALORANT.exe'],
      }
    }

    if (migrated.value) return

    model.mirror = mirrorMode.value
    model.mouseMirror = mouseMirror.value

    window.visible = true
    window.passThrough = penetrable.value
    window.alwaysOnTop = alwaysOnTop.value
    window.scale = scale.value
    window.opacity = opacity.value

    migrated.value = true
  }

  return {
    migrated,
    model,
    window,
    init,
  }
}, {
  tauri: {
    hooks: {
      beforeBackendSync: persistStateWhenWritable,
    },
  },
})
