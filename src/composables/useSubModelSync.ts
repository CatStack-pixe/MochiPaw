// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Ref } from 'vue'

import { useDebounceFn } from '@vueuse/core'
import { watch } from 'vue'

import type { SubModelInstance } from '@/stores/model'

import { LISTEN_KEY } from '@/constants'
import { useModelStore } from '@/stores/model'
import { logError } from '@/utils/diagnostics'
import { syncSubModelWindow } from '@/utils/subModelWindow'

import { useTauriListen } from './useTauriListen'

/** The persistent main window owns configuration changes emitted by submodels. */
export function useSubModelSync(ready: Readonly<Ref<boolean>>) {
  const modelStore = useModelStore()

  useTauriListen<SubModelInstance>(LISTEN_KEY.SUB_MODEL_WINDOW_CHANGED, ({ payload }) => {
    const instance = modelStore.getSubModel(payload.id)
    if (instance) Object.assign(instance.window, payload.window)
  })

  useTauriListen<{ id: string, visible: boolean }>(LISTEN_KEY.SUB_MODEL_VISIBILITY_CHANGED, ({ payload }) => {
    const instance = modelStore.getSubModel(payload.id)
    if (instance) instance.visible = payload.visible
  })

  const syncVisibleSubModels = useDebounceFn(() => {
    for (const instance of modelStore.subModels.filter(item => item.visible)) {
      void syncSubModelWindow(instance).catch((error) => {
        logError('[sub-model] configuration sync failed', { instanceId: instance.id, error })
      })
    }
  }, 16)

  watch([ready, () => modelStore.subModels.map(instance => ({
    id: instance.id,
    modelId: instance.modelId,
    visible: instance.visible,
    listeners: { ...instance.listeners },
    window: {
      scale: instance.window.scale,
      opacity: instance.window.opacity,
      radius: instance.window.radius,
      passThrough: instance.window.passThrough,
      alwaysOnTop: instance.window.alwaysOnTop,
    },
    appearance: { ...instance.appearance },
  }))], () => {
    if (ready.value) void syncVisibleSubModels()
  }, { deep: true })
}
