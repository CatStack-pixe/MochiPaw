import type { ExpressionInfo, MotionInfo } from 'easy-live2d'

import { resolveResource } from '@tauri-apps/api/path'
import { filter, find } from 'es-toolkit/compat'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

import { join } from '@/utils/path'

export type ModelMode = 'standard' | 'keyboard' | 'gamepad'
export type ModelImportKind = 'standard' | 'controlled'

export interface Model {
  id: string
  path: string
  mode: ModelMode
  isPreset: boolean
  fingerprint?: string
  importKind?: ModelImportKind
}

export interface ModelSupportKeyLayer {
  path: string
  type: 'left' | 'right' | 'overlay'
}

export interface ModelExpressionInfo extends ExpressionInfo {
  displayName?: string
}

export interface ModelMotionInfo extends MotionInfo {
  file?: string
  displayName?: string
}

export type ModelBehaviorType = 'motion' | 'expression'

export interface ModelBehaviorRef {
  id: string
  type: ModelBehaviorType
}

export interface ModelBehaviorRule {
  id: string
  name: string
  items: string[]
}

export interface ModelBehaviorGroup {
  id: string
  name: string
  items: string[]
  rules?: ModelBehaviorRule[]
}

interface PresetModel {
  id: string
  mode: ModelMode
  path: string
}

const PRESET_MODELS: PresetModel[] = [
  {
    id: 'preset-gamepad',
    mode: 'gamepad',
    path: 'gamepad',
  },
  {
    id: 'preset-keyboard',
    mode: 'keyboard',
    path: 'keyboard',
  },
  {
    id: 'preset-standard',
    mode: 'standard',
    path: 'standard',
  },
]

export const useModelStore = defineStore('model', () => {
  const modelReady = ref(true)
  const models = ref<Model[]>([])
  const currentModel = ref<Model>()
  const supportKeys = reactive<Record<string, ModelSupportKeyLayer[]>>({})
  const pressedKeys = reactive<Record<string, ModelSupportKeyLayer[]>>({})
  const activeKeys = reactive<Record<string, boolean>>({})
  const currentMotions = ref<Array<[string, ModelMotionInfo[]]>>([])
  const currentExpressions = ref<ModelExpressionInfo[]>([])
  const shortcuts = reactive<Record<string, string>>({})
  const behaviorNames = reactive<Record<string, string>>({})
  const behaviorGroups = reactive<Record<string, ModelBehaviorGroup[]>>({})

  const init = async () => {
    const modelsPath = await resolveResource('assets/models')

    const nextModels = filter(models.value, { isPreset: false })
    const presetModels = filter(models.value, { isPreset: true })

    for (const preset of [...PRESET_MODELS].reverse()) {
      const matched = find(presetModels, {
        id: preset.id,
      }) ?? find(presetModels, {
        mode: preset.mode,
        path: join(modelsPath, preset.path),
      })

      nextModels.unshift({
        id: matched?.id ?? preset.id,
        mode: preset.mode,
        isPreset: true,
        path: join(modelsPath, preset.path),
      })
    }

    const matched = find(nextModels, { id: currentModel.value?.id })

    currentModel.value = matched ?? nextModels[0]

    models.value = nextModels
  }

  return {
    modelReady,
    models,
    currentModel,
    supportKeys,
    pressedKeys,
    activeKeys,
    currentMotions,
    currentExpressions,
    shortcuts,
    behaviorNames,
    behaviorGroups,
    init,
  }
}, {
  tauri: {
    filterKeys: ['supportKeys', 'pressedKeys', 'activeKeys'],
  },
})
