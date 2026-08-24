// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { appDataDir, resolveResource } from '@tauri-apps/api/path'
import { exists, mkdir, readDir, readFile, readTextFile } from '@tauri-apps/plugin-fs'
import { filter, find } from 'es-toolkit/compat'
import JSON5 from 'json5'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { reactive, ref, watch } from 'vue'

import type { ExpressionInfo, MotionInfo } from '@/vendor/easy-live2d'

import { logInfo, logStep, logTrace } from '@/utils/diagnostics'
import { collectCubismResourceReferences, createCubismFingerprint } from '@/utils/modelFingerprint'
import { readNearestControlledRelease, readNearestProofManifest } from '@/utils/modelMetadata'
import {
  MODEL_STORE_SCHEMA_VERSION,
  prepareModelStoreStateForBackend,
  prepareModelStoreStateForFrontend,
  resolvePersistedModelSelection,
} from '@/utils/modelStorePersistence'
import { join } from '@/utils/path'
import { isCoreStoresPersistenceWritable } from '@/utils/persistence'

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
  /** True only after the main window has loaded and persisted the model selection. */
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

let modelCatalogPersistenceWritable = true

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
  const schemaVersion = ref(MODEL_STORE_SCHEMA_VERSION)
  const modelReady = ref(true)
  const models = ref<Model[]>([])
  const currentModel = ref<Model>()
  const currentModelId = ref<string>()
  const currentModelFingerprint = ref<string | null>()
  const selectionMigrationPending = ref(false)
  const customModelScanSucceeded = ref(true)
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

    const persistedCustomModels = filter(models.value, { isPreset: false })
    const presetModels = filter(models.value, { isPreset: true })
    const customModelsPath = join(await appDataDir(), 'custom-models')
    const discovery = await discoverStoredCustomModels(customModelsPath)
    const discoveredCustomModels = discovery.models
    modelCatalogPersistenceWritable = discovery.succeeded
    customModelScanSucceeded.value = discovery.succeeded
    const nextModels = mergeModelCatalog(persistedCustomModels, discoveredCustomModels)
    const persistedModelIds = new Set(persistedCustomModels.map(model => model.id))
    const recoveredModelCount = discoveredCustomModels.filter(model => !persistedModelIds.has(model.id)).length
    const catalogChanged = discovery.succeeded && (persistedCustomModels.length !== nextModels.length
      || nextModels.some((model) => {
        const persisted = persistedCustomModels.find(candidate => candidate.id === model.id)
        return !persisted || persisted.path !== model.path
      }))

    logStep('model-persistence', 'model catalog discovered', {
      customModelsPath,
      persistedCustomModelCount: persistedCustomModels.length,
      discoveredCustomModelCount: discoveredCustomModels.length,
      recoveredModelCount,
      customModelScanSucceeded: discovery.succeeded,
    })

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

    models.value = nextModels

    const legacyCurrentModel = currentModel.value
    const selectionFingerprint = currentModelFingerprint.value ?? legacyCurrentModel?.fingerprint
    const fingerprintMigrationPending = selectionMigrationPending.value
      || (!currentModelId.value && Boolean(legacyCurrentModel))

    if (
      (fingerprintMigrationPending || !currentModelId.value)
      && selectionFingerprint
      && !nextModels.some(model => model.id === currentModelId.value)
    ) {
      await fillMissingModelFingerprints(nextModels)
    }

    const selection = resolvePersistedModelSelection(nextModels, currentModelId.value, {
      id: legacyCurrentModel?.id ?? currentModelId.value ?? '',
      fingerprint: selectionFingerprint,
    }, fingerprintMigrationPending || !currentModelId.value)

    currentModel.value = selection.model
    currentModelId.value = selection.currentModelId
    currentModelFingerprint.value = selection.currentModelFingerprint ?? null
    selectionMigrationPending.value = fingerprintMigrationPending && selection.usedRuntimeFallback

    logInfo('[model-persistence] model catalog initialized', {
      modelCount: nextModels.length,
      customModelCount: nextModels.filter(model => !model.isPreset).length,
      recoveredModelCount,
      currentModelId: currentModel.value?.id,
      persistedCurrentModelId: currentModelId.value,
      selectionMigrated: selection.selectionMigrated,
      usedRuntimeFallback: selection.usedRuntimeFallback,
      persistenceChanged: catalogChanged || selection.selectionMigrated,
      customModelScanSucceeded: discovery.succeeded,
    })

    return {
      modelCount: nextModels.length,
      customModelCount: nextModels.filter(model => !model.isPreset).length,
      recoveredModelCount,
      selectionMigrated: selection.selectionMigrated,
      usedRuntimeFallback: selection.usedRuntimeFallback,
      persistenceChanged: catalogChanged || selection.selectionMigrated,
      customModelScanSucceeded: discovery.succeeded,
    }
  }

  watch(currentModelId, (modelId) => {
    if (!modelId) return

    const resolved = models.value.find(model => model.id === modelId)
    if (resolved) currentModel.value = resolved
  })

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
    schemaVersion,
    modelReady,
    models,
    currentModel,
    currentModelId,
    currentModelFingerprint,
    selectionMigrationPending,
    customModelScanSucceeded,
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
    hooks: {
      beforeBackendSync: state => prepareModelStoreStateForBackend(
        state,
        isCoreStoresPersistenceWritable(),
        modelCatalogPersistenceWritable,
      ),
      beforeFrontendSync: prepareModelStoreStateForFrontend,
    },
    saveInterval: 500,
    saveStrategy: 'debounce',
  },
})

export function mergeModelCatalog(persistedModels: Model[], discoveredModels: Model[]) {
  const persistedById = new Map(persistedModels.map(model => [model.id, model]))

  return discoveredModels.map((discoveredModel) => {
    const model = persistedById.get(discoveredModel.id)

    if (!model) return discoveredModel

    return {
      ...discoveredModel,
      ...model,
      id: discoveredModel.id,
      path: discoveredModel.path,
    }
  })
}

async function discoverStoredCustomModels(customModelsPath: string) {
  let entries

  try {
    await mkdir(customModelsPath, { recursive: true })
    entries = await readDir(customModelsPath)
  } catch (error) {
    logTrace('[model-persistence] custom model directory unavailable', { customModelsPath, error })
    return { models: [], succeeded: false }
  }
  const discoveredModels: Model[] = []
  let succeeded = true

  for (const entry of entries) {
    if (!entry.isDirectory || !entry.name) continue

    const modelPath = join(customModelsPath, entry.name)
    const inspection = await inspectStoredModelDirectory(modelPath)

    if (!inspection.succeeded) {
      succeeded = false
      logTrace('[model-persistence] custom model directory could not be inspected', { modelPath })
      continue
    }

    const { modelFile } = inspection

    if (!modelFile) {
      succeeded = false
      logTrace('[model-persistence] skipped custom model directory without model JSON', { modelPath })
      continue
    }

    const model = {
      id: entry.name,
      displayName: await readStoredCubismModelName(modelFile),
      path: modelPath,
      mode: await inferStoredModelMode(modelPath),
      isPreset: false,
      importKind: 'standard' as const,
      proofStatus: 'unsigned' as const,
    }

    discoveredModels.push(model)
    logTrace('[model-persistence] discovered custom model directory', {
      modelId: model.id,
      modelPath,
      mode: model.mode,
    })
  }

  logInfo('[model-persistence] custom model directory scan completed', {
    customModelsPath,
    discoveredModelCount: discoveredModels.length,
    succeeded,
  })

  return { models: discoveredModels, succeeded }
}

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
  return (await inspectStoredModelDirectory(modelPath)).modelFile
}

type StoredModelDirectoryReader = (
  modelPath: string,
) => Promise<Array<{ isFile: boolean, name: string }>>

export async function inspectStoredModelDirectory(
  modelPath: string,
  reader: StoredModelDirectoryReader = readDir,
) {
  try {
    const files = await reader(modelPath)
    const modelFile = files.find(file => file.isFile && file.name.endsWith('.model3.json'))

    return {
      modelFile: modelFile ? join(modelPath, modelFile.name) : undefined,
      succeeded: Boolean(modelFile),
    }
  } catch {
    return { modelFile: undefined, succeeded: false }
  }
}

async function inferStoredModelMode(modelPath: string): Promise<ModelMode> {
  const files = await readDir(join(modelPath, 'resources', 'right-keys')).catch((error) => {
    logTrace('[model-persistence] failed to inspect model mode resources', { modelPath, error })
    return []
  })

  if (!files.length) return 'standard'

  const fileNames = files.map(file => file.name.split('.')[0])
  return fileNames.includes('East') ? 'gamepad' : 'keyboard'
}

async function fillMissingModelFingerprints(models: Model[]) {
  for (const model of models) {
    if (model.fingerprint || model.isPreset) continue

    model.fingerprint = await getStoredModelFingerprint(model).catch(() => undefined)
  }
}

async function getStoredModelFingerprint(model: Model) {
  const modelFile = await findStoredModelFile(model.path)
  if (!modelFile) return undefined

  const modelJSON = JSON5.parse(await readTextFile(modelFile))
  const resources = collectCubismResourceReferences(modelFile, modelJSON)

  return await createCubismFingerprint(model.mode, resources, async (path) => {
    if (!await exists(path)) return undefined

    return await readFile(path)
  })
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
