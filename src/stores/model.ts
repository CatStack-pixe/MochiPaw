// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { resolveResource } from '@tauri-apps/api/path'
import { readDir, readTextFile } from '@tauri-apps/plugin-fs'
import { filter, find } from 'es-toolkit/compat'
import JSON5 from 'json5'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

import type { ExpressionInfo, MotionInfo } from '@/vendor/easy-live2d'

import { readNearestControlledRelease, readNearestProofManifest } from '@/utils/modelMetadata'
import { join } from '@/utils/path'

export type ModelMode = 'standard' | 'keyboard' | 'gamepad'
export type ModelImportKind = 'standard' | 'controlled'
export type ModelProofStatus = 'unsigned' | 'manifest-detected' | 'controlled-release'

export interface ModelAuthorProfile {
  displayName?: string
  statement?: string
  homepage?: string
  contact?: string
  community?: string
  source?: string
  collaborators?: string[]
}

export interface ModelControlledRelease {
  packageId?: string
  releaseCode?: string
  activationMode?: string
  runtimeTelemetryRequired?: boolean
  offlineLeaseAllowed?: boolean
  reimportRestricted?: boolean
  contentEncryption?: {
    status?: string
    algorithm?: string
    keyDelivery?: string
    encryptedFiles?: Array<{
      path?: string
      algorithm?: string
      nonce?: string
      ciphertextSha256?: string
      originalSize?: number
      ciphertextSize?: number
    }>
  }
}

export interface ModelRuntimeLease {
  leaseId: string
  expiresAt: number
  leaseToken?: string
}

export interface Model {
  id: string
  customName?: string
  displayName?: string
  path: string
  mode: ModelMode
  isPreset: boolean
  fingerprint?: string
  importKind?: ModelImportKind
  proofStatus?: ModelProofStatus
  packageId?: string
  author?: ModelAuthorProfile
  controlledRelease?: ModelControlledRelease
  dispatchToken?: string
  activationToken?: string
  runtimeLease?: ModelRuntimeLease
}

export type ModelSwitchSnapshot = Pick<Model, 'id' | 'path' | 'mode' | 'isPreset' | 'importKind' | 'proofStatus'>

export interface ModelSwitchRequest {
  requestId: string
  model: ModelSwitchSnapshot
}

export interface ModelSwitchAcknowledgement {
  requestId: string
  modelId: string
  accepted: boolean
  reason?: string
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

export interface SubModelListeners {
  keyboard: boolean
  mouse: boolean
  gamepad: boolean
  typingBehavior: boolean
}

export interface SubModelWindowSettings {
  x?: number
  y?: number
  scale: number
  opacity: number
  radius: number
  passThrough: boolean
  alwaysOnTop: boolean
}

export interface SubModelAppearanceSettings {
  mirror: boolean
  mouseMirror: boolean
  maxFPS: number
}

export interface SubModelInstance {
  id: string
  modelId: string
  customName?: string
  note?: string
  visible: boolean
  showOnLaunch: boolean
  createdAt: number
  listeners: SubModelListeners
  window: SubModelWindowSettings
  appearance: SubModelAppearanceSettings
}

interface PresetModel {
  id: string
  mode: ModelMode
  path: string
}

interface StoredCubismModelJSON {
  Name?: string
  DisplayName?: string
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
  const subModels = ref<SubModelInstance[]>([])

  const init = async () => {
    const modelsPath = await resolveResource('assets/models')

    const nextModels = filter(models.value, { isPreset: false })
    const presetModels = filter(models.value, { isPreset: true })

    await Promise.all(nextModels.map(fillModelMetadata))

    for (const preset of [...PRESET_MODELS].reverse()) {
      const matched = find(presetModels, {
        id: preset.id,
      }) ?? find(presetModels, {
        mode: preset.mode,
        path: join(modelsPath, preset.path),
      })

      nextModels.unshift({
        id: matched?.id ?? preset.id,
        customName: matched?.customName,
        mode: preset.mode,
        isPreset: true,
        path: join(modelsPath, preset.path),
      })
    }

    const matched = find(nextModels, { id: currentModel.value?.id })

    currentModel.value = matched ?? nextModels[0]

    models.value = nextModels
  }

  const createSubModel = (modelId: string) => {
    const instance: SubModelInstance = {
      id: nanoid(),
      modelId,
      customName: '',
      note: '',
      visible: true,
      showOnLaunch: true,
      createdAt: Date.now(),
      listeners: {
        keyboard: true,
        mouse: true,
        gamepad: true,
        typingBehavior: true,
      },
      window: {
        scale: 100,
        opacity: 100,
        radius: 0,
        passThrough: false,
        alwaysOnTop: false,
      },
      appearance: {
        mirror: false,
        mouseMirror: false,
        maxFPS: 60,
      },
    }

    subModels.value.push(instance)

    return instance
  }

  const getSubModel = (id: string) => subModels.value.find(instance => instance.id === id)

  const removeSubModel = (id: string) => {
    const index = subModels.value.findIndex(instance => instance.id === id)

    if (index !== -1) {
      subModels.value.splice(index, 1)
    }
  }

  const removeSubModelsByModelId = (modelId: string) => {
    subModels.value = subModels.value.filter(instance => instance.modelId !== modelId)
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
    subModels,
    init,
    createSubModel,
    getSubModel,
    removeSubModel,
    removeSubModelsByModelId,
  }
}, {
  tauri: {
    filterKeys: ['supportKeys', 'pressedKeys', 'activeKeys'],
  },
})

async function fillModelMetadata(model: Model) {
  const proofManifest = await readNearestProofManifest(model.path)
  const controlledRelease = await readNearestControlledRelease(model.path)

  model.importKind = controlledRelease ? 'controlled' : model.importKind ?? 'standard'
  model.proofStatus = controlledRelease ? 'controlled-release' : proofManifest ? 'manifest-detected' : 'unsigned'
  model.packageId = proofManifest?.packageId ?? controlledRelease?.packageId ?? model.packageId
  model.author = proofManifest?.author ?? model.author
  model.controlledRelease = controlledRelease ?? model.controlledRelease
  model.dispatchToken = proofManifest?.dispatch?.dispatchToken ?? model.dispatchToken
  model.activationToken = proofManifest?.dispatch?.activationToken ?? model.activationToken

  if (!model.isPreset && !model.displayName?.trim()) {
    model.displayName = await inferStoredModelDisplayName(model, proofManifest?.modelName)
  }
}

async function inferStoredModelDisplayName(model: Model, proofModelName?: string) {
  const proofName = normalizeDisplayName(proofModelName)
  if (proofName) return proofName

  const modelFile = await findStoredModelFile(model.path)
  if (!modelFile) return undefined

  const modelName = await readStoredCubismModelName(modelFile)
  if (modelName) return modelName

  return stripModelFileExtension(getPathBaseName(modelFile))
}

async function readStoredCubismModelName(modelFile: string) {
  try {
    const modelJSON = JSON5.parse(await readTextFile(modelFile)) as StoredCubismModelJSON

    return normalizeDisplayName(modelJSON.DisplayName ?? modelJSON.Name)
  } catch {
    return undefined
  }
}

async function findStoredModelFile(modelPath: string) {
  const files = await readDir(modelPath).catch(() => [])
  const modelFile = files.find(file => file.isFile && file.name.endsWith('.model3.json'))

  return modelFile ? join(modelPath, modelFile.name) : undefined
}

function normalizeDisplayName(value: unknown) {
  if (typeof value !== 'string') return undefined

  const displayName = value.trim()

  if (!displayName || /^(?:none|null|undefined|n\/a)$/i.test(displayName)) return undefined

  return displayName
}

export function getModelDisplayName(model: Pick<Model, 'id' | 'customName' | 'displayName'>) {
  return normalizeDisplayName(model.customName) ?? normalizeDisplayName(model.displayName) ?? model.id
}

export function getSubModelDisplayName(
  instance: Pick<SubModelInstance, 'modelId' | 'customName'>,
  model?: Pick<Model, 'id' | 'customName' | 'displayName'>,
) {
  return normalizeDisplayName(instance.customName) ?? (model ? getModelDisplayName(model) : instance.modelId)
}

function getPathBaseName(path: string) {
  return path.split(/[\\/]/).at(-1) ?? ''
}

function stripModelFileExtension(fileName: string) {
  return fileName.replace(/\.model3\.json$/i, '').trim() || undefined
}
