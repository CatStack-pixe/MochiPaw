<!-- SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { appDataDir } from '@tauri-apps/api/path'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { open } from '@tauri-apps/plugin-dialog'
import { copyFile, exists, mkdir, readDir, readFile, readTextFile, remove, stat } from '@tauri-apps/plugin-fs'
import { message } from 'antdv-next'
import JSON5 from 'json5'
import { nanoid } from 'nanoid'
import { computed, onMounted, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type {
  ModelAuthorProfile,
  ModelControlledRelease,
  ModelMode,
  ModelProofStatus,
} from '@/stores/model'

import { INVOKE_KEY } from '@/constants'
import { useModelStore } from '@/stores/model'
import { readNearestControlledRelease, readNearestProofManifest } from '@/utils/modelMetadata'
import { join } from '@/utils/path'
import { ensureRuntimeLease, reportRuntimeEventQuietly } from '@/utils/runtimeTelemetry'

interface LegacyPetConfig {
  standard?: LegacyStandardConfig
  keyboard?: LegacyKeyboardConfig
  gamepad?: LegacyGamepadConfig
}

interface LegacyStandardConfig {
  hand?: number[][]
  keyboard?: number[][]
  face?: number[][]
}

interface LegacyKeyboardConfig {
  lefthand?: number[][]
  righthand?: number[][]
  keyboard?: number[][]
  face?: number[][]
}

interface LegacyGamepadConfig {
  lefthand?: number[][]
  righthand?: number[][]
  keyboard?: number[][]
  face?: number[][]
}

interface CubismModelJSON {
  Name?: string
  DisplayName?: string
  FileReferences?: {
    Moc?: string
    Textures?: string[]
    Physics?: string
    DisplayInfo?: string
  }
}

interface ImportVariant {
  mode: ModelMode
  rootPath: string
  modelPath: string
  displayName?: string
  fingerprint: string
  importKind: 'standard' | 'controlled'
  proofStatus: ModelProofStatus
  packageId?: string
  dispatchToken?: string
  author?: ModelAuthorProfile
  controlledRelease?: ModelControlledRelease
  proofDirectory?: string
  controlDirectory?: string
}

interface KeyImageRef {
  sourceDir: string
  sourceIndex: number
  shortcut: string
  targetDir: 'left-keys' | 'right-keys' | 'keyboards' | 'faces'
}

const emit = defineEmits<{
  imported: []
}>()

const dropRef = useTemplateRef('drop')
const dragenter = ref(false)
const importing = ref(false)
const importProgress = ref({ current: 0, total: 0 })
const selectPaths = ref<string[]>([])
const modelStore = useModelStore()
const { t } = useI18n()

const LEGACY_MODELS: ModelMode[] = ['standard', 'keyboard', 'gamepad']

const KEY_CODE_NAMES: Record<number, string> = {
  8: 'Backspace',
  9: 'Tab',
  13: 'Return',
  16: 'Shift',
  17: 'Control',
  18: 'Alt',
  20: 'CapsLock',
  27: 'Escape',
  32: 'Space',
  37: 'LeftArrow',
  38: 'UpArrow',
  39: 'RightArrow',
  40: 'DownArrow',
  46: 'Delete',
  48: 'Num0',
  49: 'Num1',
  50: 'Num2',
  51: 'Num3',
  52: 'Num4',
  53: 'Num5',
  54: 'Num6',
  55: 'Num7',
  56: 'Num8',
  57: 'Num9',
  65: 'KeyA',
  66: 'KeyB',
  67: 'KeyC',
  68: 'KeyD',
  69: 'KeyE',
  70: 'KeyF',
  71: 'KeyG',
  72: 'KeyH',
  73: 'KeyI',
  74: 'KeyJ',
  75: 'KeyK',
  76: 'KeyL',
  77: 'KeyM',
  78: 'KeyN',
  79: 'KeyO',
  80: 'KeyP',
  81: 'KeyQ',
  82: 'KeyR',
  83: 'KeyS',
  84: 'KeyT',
  85: 'KeyU',
  86: 'KeyV',
  87: 'KeyW',
  88: 'KeyX',
  89: 'KeyY',
  90: 'KeyZ',
  91: 'Meta',
  92: 'Meta',
  93: 'Meta',
  96: 'Num0',
  97: 'Num1',
  98: 'Num2',
  99: 'Num3',
  100: 'Num4',
  101: 'Num5',
  102: 'Num6',
  103: 'Num7',
  104: 'Num8',
  105: 'Num9',
  106: 'KpMultiply',
  107: 'KpPlus',
  109: 'KpMinus',
  110: 'KpDecimal',
  111: 'KpDivide',
  189: 'Minus',
  192: 'BackQuote',
  222: 'Quote',
}

const GAMEPAD_BUTTON_NAMES = [
  'South',
  'East',
  'West',
  'North',
  'LeftTrigger',
  'RightTrigger',
  'LeftTrigger2',
  'RightTrigger2',
  'LeftThumb',
  'RightThumb',
  'DPadUp',
  'DPadDown',
  'DPadLeft',
  'DPadRight',
]

type ImportFromPathResult
  = | { status: 'imported', models: Array<ReturnType<typeof createImportedModel>> }
    | { status: 'duplicate' }

onMounted(() => {
  const appWindow = getCurrentWebviewWindow()

  appWindow.onDragDropEvent(({ payload }) => {
    if (importing.value) return

    const { type } = payload

    if (type === 'over') {
      const { x, y } = payload.position

      if (dropRef.value) {
        const { left, right, top, bottom } = dropRef.value.getBoundingClientRect()

        const inBoundsX = x >= left && x <= right
        const inBoundsY = y >= top && y <= bottom

        dragenter.value = inBoundsX && inBoundsY
      }
    } else if (type === 'drop' && dragenter.value) {
      dragenter.value = false

      selectPaths.value = payload.paths
    } else {
      dragenter.value = false
    }
  })
})

const importHint = computed(() => {
  if (!importing.value) {
    return t('pages.preference.model.hints.clickOrDragToImport')
  }

  return t('pages.preference.model.hints.importing', {
    current: importProgress.value.current,
    total: importProgress.value.total,
  })
})

async function handleUpload() {
  if (importing.value) return

  const selected = await open({
    multiple: true,
    filters: [
      {
        name: 'Model',
        extensions: ['zip', 'model3.json'],
      },
    ],
  })

  if (!selected) return

  selectPaths.value = Array.isArray(selected) ? selected : [selected]
}

watch(selectPaths, async (paths) => {
  if (!paths.length || importing.value) return

  importing.value = true
  importProgress.value = { current: 1, total: paths.length }

  for (const [index, fromPath] of paths.entries()) {
    importProgress.value = { current: index + 1, total: paths.length }

    try {
      const result = await importFromPath(fromPath)

      if (result.status === 'duplicate') {
        message.info(t('pages.preference.model.hints.alreadyImported'))

        continue
      }

      for (const model of result.models) {
        modelStore.models.push(model)
        reportRuntimeEventQuietly(model, 'imported')
      }

      emit('imported')
      message.success(t('pages.preference.model.hints.importSuccess'))
    } catch (error) {
      message.error(String(error))
    }
  }

  importing.value = false
  importProgress.value = { current: 0, total: 0 }
  selectPaths.value = []
})

async function importFromPath(fromPath: string) {
  const sourcePath = await prepareImportSource(fromPath)
  const variants = await discoverImportVariants(sourcePath)

  if (!variants.length) {
    throw new Error('No model3.json found')
  }

  const models = []
  const importedFingerprints = await getImportedFingerprints()

  for (const variant of variants) {
    if (importedFingerprints.has(variant.fingerprint)) continue

    const id = nanoid()
    const toPath = join(await appDataDir(), 'custom-models', id)

    await invoke(INVOKE_KEY.COPY_DIR, {
      fromPath: variant.modelPath,
      toPath,
    })

    await copyMetadataDirectories(variant, toPath)

    const model = createImportedModel({
      id,
      displayName: variant.displayName,
      path: toPath,
      mode: variant.mode,
      isPreset: false,
      fingerprint: variant.fingerprint,
      importKind: variant.importKind,
      proofStatus: variant.proofStatus,
      packageId: variant.packageId,
      dispatchToken: variant.dispatchToken,
      author: variant.author,
      controlledRelease: variant.controlledRelease,
    })

    try {
      await ensureRuntimeLease(model)
      await normalizeResources(variant, toPath)
    } catch (error) {
      await remove(toPath, { recursive: true }).catch(() => undefined)
      throw error
    }

    models.push(model)

    importedFingerprints.add(variant.fingerprint)
  }

  if (!models.length) {
    return { status: 'duplicate' } satisfies ImportFromPathResult
  }

  return { status: 'imported', models } satisfies ImportFromPathResult
}

function createImportedModel(model: {
  id: string
  displayName?: string
  path: string
  mode: ModelMode
  isPreset: boolean
  fingerprint?: string
  importKind?: 'standard' | 'controlled'
  proofStatus?: ModelProofStatus
  packageId?: string
  dispatchToken?: string
  author?: ModelAuthorProfile
  controlledRelease?: ModelControlledRelease
}) {
  return model
}

async function prepareImportSource(fromPath: string) {
  const info = await stat(fromPath)

  if (info.isDirectory) return fromPath

  if (!fromPath.toLowerCase().endsWith('.zip')) {
    return await getModelDirectoryFromFile(fromPath)
  }

  const importPath = join(await appDataDir(), 'model-imports', nanoid())

  await invoke(INVOKE_KEY.EXTRACT_ZIP, {
    fromPath,
    toPath: importPath,
  })

  return importPath
}

async function getModelDirectoryFromFile(filePath: string) {
  const parts = filePath.split(/[\\/]/)

  parts.pop()

  return parts.join(filePath.includes('\\') ? '\\' : '/')
}

async function discoverImportVariants(sourcePath: string) {
  const variants = await discoverLegacyVariants(sourcePath)

  if (variants.length) return variants

  return await discoverCubismVariants(sourcePath)
}

async function discoverLegacyVariants(sourcePath: string) {
  const imgDirs = await findDirectoriesNamed(sourcePath, 'img')
  const variants: ImportVariant[] = []

  for (const imgDir of imgDirs) {
    for (const mode of LEGACY_MODELS) {
      const rootPath = join(imgDir, mode)
      const modelPath = join(rootPath, 'cat_model')

      if (!await exists(join(modelPath, 'cat.model3.json'))) continue

      const proofManifest = await readNearestProofManifest(modelPath, sourcePath)
      const controlledRelease = await readNearestControlledRelease(modelPath, sourcePath)
      const proofDirectory = await findNearestManifestDirectory(modelPath, 'mochi-proof', 'manifest.json', sourcePath)
      const controlDirectory = await findNearestManifestDirectory(modelPath, 'mochi-control', 'release.json', sourcePath)

      variants.push({
        mode,
        rootPath,
        modelPath,
        displayName: await inferImportDisplayName({
          modelPath,
          sourcePath,
          proofManifest,
        }),
        fingerprint: await getModelFingerprint(modelPath, mode),
        importKind: controlledRelease ? 'controlled' : 'standard',
        proofStatus: controlledRelease ? 'controlled-release' : proofManifest ? 'manifest-detected' : 'unsigned',
        packageId: proofManifest?.packageId ?? controlledRelease?.packageId,
        dispatchToken: proofManifest?.dispatch?.dispatchToken,
        author: proofManifest?.author,
        controlledRelease,
        proofDirectory,
        controlDirectory,
      })
    }
  }

  return variants
}

async function discoverCubismVariants(sourcePath: string) {
  const modelPaths = await findModelDirectories(sourcePath)

  return await Promise.all(modelPaths.map(async (modelPath): Promise<ImportVariant> => {
    const mode = await inferMode(modelPath)
    const proofManifest = await readNearestProofManifest(modelPath, sourcePath)
    const controlledRelease = await readNearestControlledRelease(modelPath, sourcePath)
    const proofDirectory = await findNearestManifestDirectory(modelPath, 'mochi-proof', 'manifest.json', sourcePath)
    const controlDirectory = await findNearestManifestDirectory(modelPath, 'mochi-control', 'release.json', sourcePath)

    return {
      mode,
      rootPath: modelPath,
      modelPath,
      displayName: await inferImportDisplayName({
        modelPath,
        sourcePath,
        proofManifest,
      }),
      fingerprint: await getModelFingerprint(modelPath, mode),
      importKind: controlledRelease ? 'controlled' : 'standard',
      proofStatus: controlledRelease ? 'controlled-release' : proofManifest ? 'manifest-detected' : 'unsigned',
      packageId: proofManifest?.packageId ?? controlledRelease?.packageId,
      dispatchToken: proofManifest?.dispatch?.dispatchToken,
      author: proofManifest?.author,
      controlledRelease,
      proofDirectory,
      controlDirectory,
    }
  }))
}

async function copyMetadataDirectories(variant: ImportVariant, toPath: string) {
  if (variant.proofDirectory) {
    await invoke(INVOKE_KEY.COPY_DIR, {
      fromPath: variant.proofDirectory,
      toPath: join(toPath, 'mochi-proof'),
    })
  }
  if (variant.controlDirectory) {
    await invoke(INVOKE_KEY.COPY_DIR, {
      fromPath: variant.controlDirectory,
      toPath: join(toPath, 'mochi-control'),
    })
  }
}

async function findNearestManifestDirectory(startPath: string, manifestDirectory: string, manifestFile: string, stopPath?: string) {
  let currentPath = startPath
  const normalizedStopPath = stopPath ? normalizePath(stopPath) : undefined

  while (currentPath) {
    const candidate = join(currentPath, manifestDirectory)
    if (await exists(join(candidate, manifestFile))) return candidate

    const normalizedCurrentPath = normalizePath(currentPath)
    if (normalizedStopPath && normalizedCurrentPath === normalizedStopPath) return undefined

    const parentPath = getParentPath(currentPath)
    if (!parentPath || normalizePath(parentPath) === normalizedCurrentPath) return undefined

    currentPath = parentPath
  }

  return undefined
}

async function inferImportDisplayName({
  modelPath,
  sourcePath,
  proofManifest,
}: {
  modelPath: string
  sourcePath: string
  proofManifest: { modelName?: string } | null
}) {
  const manifestName = normalizeDisplayName(proofManifest?.modelName)
  if (manifestName) return manifestName

  const modelFile = await findModelFile(modelPath).catch(() => undefined)
  if (modelFile) {
    const modelJSON = await readCubismModelJSON(modelFile).catch(() => undefined)
    const modelName = normalizeDisplayName(modelJSON?.DisplayName ?? modelJSON?.Name)

    if (modelName) return modelName

    const modelFileBaseName = stripModelFileExtension(getPathBaseName(modelFile))

    if (modelFileBaseName) return modelFileBaseName
  }

  return normalizeDisplayName(getPathBaseName(sourcePath))
}

async function findDirectoriesNamed(rootPath: string, name: string) {
  const results: string[] = []

  await walkDirectories(rootPath, async (path, entryName) => {
    if (entryName.toLowerCase() === name) {
      results.push(path)
    }
  })

  return results
}

async function findModelDirectories(rootPath: string) {
  const results: string[] = []

  await walkDirectories(rootPath, async (path) => {
    const files = await readDir(path).catch(() => [])
    const hasModel = files.some(file => file.isFile && file.name.endsWith('.model3.json'))

    if (hasModel) {
      results.push(path)
    }
  })

  return results
}

async function walkDirectories(
  rootPath: string,
  visit: (path: string, name: string) => void | Promise<void>,
) {
  const pending = [rootPath]

  while (pending.length) {
    const path = pending.shift()!
    const entries = await readDir(path).catch(() => [])
    const name = path.split(/[\\/]/).at(-1) ?? ''

    await visit(path, name)

    for (const entry of entries) {
      if (!entry.isDirectory) continue

      pending.push(join(path, entry.name))
    }
  }
}

async function inferMode(modelPath: string): Promise<ModelMode> {
  const files = await readDir(join(modelPath, 'resources', 'right-keys')).catch(() => [])

  if (!files.length) return 'standard'

  const fileNames = files.map(file => file.name.split('.')[0])

  return fileNames.includes('East') ? 'gamepad' : 'keyboard'
}

async function getImportedFingerprints() {
  const fingerprints = new Set<string>()

  for (const model of modelStore.models) {
    const fingerprint = model.fingerprint ?? await getModelFingerprint(model.path, model.mode).catch(() => undefined)

    if (!fingerprint) continue

    model.fingerprint = fingerprint
    fingerprints.add(fingerprint)
  }

  return fingerprints
}

async function getModelFingerprint(modelPath: string, mode: ModelMode) {
  const modelFile = await findModelFile(modelPath)
  const modelJSON = await readCubismModelJSON(modelFile)
  const references = modelJSON.FileReferences
  const files = [
    { key: modelFile.split(/[\\/]/).at(-1) ?? 'model3.json', path: modelFile },
    references?.Moc ? { key: references.Moc, path: join(modelPath, references.Moc) } : undefined,
    references?.Physics ? { key: references.Physics, path: join(modelPath, references.Physics) } : undefined,
    references?.DisplayInfo ? { key: references.DisplayInfo, path: join(modelPath, references.DisplayInfo) } : undefined,
    ...references?.Textures?.map(texture => ({ key: texture, path: join(modelPath, texture) })) ?? [],
  ].filter(file => file !== undefined)
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let totalLength = 0

  for (const file of files) {
    const keyBytes = encoder.encode(file.key)

    chunks.push(keyBytes)
    totalLength += keyBytes.length

    if (!await exists(file.path)) continue

    const fileBytes = await readFile(file.path)

    chunks.push(fileBytes)
    totalLength += fileBytes.length
  }

  const digest = await crypto.subtle.digest('SHA-256', concatBytes(chunks, totalLength))
  const hash = [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')

  return `${mode}:${hash}`
}

async function readCubismModelJSON(modelFile: string) {
  return JSON5.parse(await readTextFile(modelFile)) as CubismModelJSON
}

function concatBytes(chunks: Uint8Array[], totalLength: number) {
  const bytes = new Uint8Array(totalLength)
  let offset = 0

  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }

  return bytes
}

async function findModelFile(modelPath: string) {
  const files = await readDir(modelPath)
  const modelFile = files.find(file => file.isFile && file.name.endsWith('.model3.json'))

  if (!modelFile) {
    throw new Error('No model3.json found')
  }

  return join(modelPath, modelFile.name)
}

async function normalizeResources(variant: ImportVariant, modelPath: string) {
  const resourcesPath = join(modelPath, 'resources')

  await mkdir(resourcesPath, { recursive: true })
  await copyOptionalFile(join(variant.rootPath, 'cat.png'), join(resourcesPath, 'cover.png'))
  await copyFirstExistingFile([
    join(variant.rootPath, 'bg.png'),
    join(variant.rootPath, 'mousebg.png'),
    join(variant.rootPath, 'tabletbg.png'),
  ], join(resourcesPath, 'background.png'))

  const config = await readLegacyConfig(variant.rootPath)

  if (!config) return

  const keyImages = getKeyImageRefs(variant, config)

  for (const item of keyImages) {
    const source = join(variant.rootPath, item.sourceDir, `${item.sourceIndex}.png`)
    const targetDir = join(resourcesPath, item.targetDir)

    if (!await exists(source)) continue

    await mkdir(targetDir, { recursive: true })
    await copyFile(source, join(targetDir, `${item.shortcut}.png`))
  }
}

async function readLegacyConfig(rootPath: string) {
  const configPath = await findNearestConfig(rootPath)

  if (!configPath) return

  return JSON5.parse(await readTextFile(configPath)) as LegacyPetConfig
}

async function findNearestConfig(rootPath: string) {
  let currentPath = rootPath

  while (currentPath) {
    const configPath = join(currentPath, 'config.json')

    if (await exists(configPath)) return configPath

    const nextPath = getParentPath(currentPath)

    if (nextPath === currentPath) return

    currentPath = nextPath
  }
}

function getParentPath(path: string) {
  const separator = path.includes('\\') ? '\\' : '/'
  const parts = path.split(/[\\/]/)

  parts.pop()

  return parts.join(separator)
}

function normalizePath(path: string) {
  return path.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

function normalizeDisplayName(value: unknown) {
  if (typeof value !== 'string') return undefined

  const displayName = value.trim()

  if (!displayName || /^(?:none|null|undefined|n\/a)$/i.test(displayName)) return undefined

  return displayName
}

function getPathBaseName(path: string) {
  return path.split(/[\\/]/).at(-1) ?? ''
}

function stripModelFileExtension(fileName: string) {
  return fileName.replace(/\.model3\.json$/i, '').trim() || undefined
}

function getKeyImageRefs(variant: ImportVariant, config: LegacyPetConfig) {
  if (variant.mode === 'gamepad') {
    return getPairedKeyImageRefs(config.gamepad?.keyboard, 'keyboard', 'keyboards', 'gamepad')
      .concat(getPairedKeyImageRefs(config.gamepad?.face, 'face', 'faces', 'keyboard'))
      .concat(getPairedKeyImageRefs(config.gamepad?.lefthand, 'lefthand', 'left-keys', 'gamepad'))
      .concat(getPairedKeyImageRefs(config.gamepad?.righthand, 'righthand', 'right-keys', 'gamepad'))
  }

  if (variant.mode === 'keyboard') {
    return getPairedKeyImageRefs(config.keyboard?.keyboard, 'keyboard', 'keyboards', 'keyboard')
      .concat(getPairedKeyImageRefs(config.keyboard?.face, 'face', 'faces', 'keyboard'))
      .concat(getPairedKeyImageRefs(config.keyboard?.lefthand, 'lefthand', 'left-keys', 'keyboard'))
      .concat(getPairedKeyImageRefs(config.keyboard?.righthand, 'righthand', 'right-keys', 'keyboard'))
  }

  return getPairedKeyImageRefs(config.standard?.keyboard, 'keyboard', 'keyboards', 'keyboard')
    .concat(getPairedKeyImageRefs(config.standard?.face, 'face', 'faces', 'keyboard'))
    .concat(getPairedKeyImageRefs(config.standard?.hand, 'hand', 'left-keys', 'keyboard'))
}

function getPairedKeyImageRefs(
  groups: number[][] | undefined,
  sourceDir: string,
  targetDir: KeyImageRef['targetDir'],
  source: 'keyboard' | 'gamepad',
) {
  const refs: KeyImageRef[] = []

  for (const [sourceIndex, keyCodes] of groups?.entries() ?? []) {
    const shortcut = getShortcutName(keyCodes, source)

    if (!shortcut) continue

    refs.push({
      sourceDir,
      sourceIndex,
      shortcut,
      targetDir,
    })
  }

  return refs
}

function getShortcutName(keyCodes: number[], source: 'keyboard' | 'gamepad') {
  const keyNames = keyCodes
    .map(code => getKeyName(code, source))
    .filter(keyName => keyName !== undefined)

  if (!keyNames.length) return

  return keyNames.join('+')
}

function getKeyName(code: number, source: 'keyboard' | 'gamepad') {
  if (source === 'gamepad') {
    return GAMEPAD_BUTTON_NAMES[code]
  }

  return KEY_CODE_NAMES[code]
}

async function copyOptionalFile(fromPath: string, toPath: string) {
  if (!await exists(fromPath)) return

  await copyFile(fromPath, toPath)
}

async function copyFirstExistingFile(fromPaths: string[], toPath: string) {
  for (const fromPath of fromPaths) {
    if (!await exists(fromPath)) continue

    await copyFile(fromPath, toPath)

    return
  }
}
</script>

<template>
  <div
    ref="drop"
    class="w-full flex flex-col items-center justify-center gap-4 b-1 b-dashed bg-[--ant-color-fill-quaternary] transition b-border rounded-lg hover:border-primary"
    :class="{
      'border-primary': dragenter || importing,
      'cursor-not-allowed opacity-70': importing,
      'cursor-pointer': !importing,
    }"
    @click="handleUpload"
  >
    <div
      class="text-12 text-primary"
      :class="importing ? 'i-solar:refresh-bold animate-spin' : 'i-solar:upload-square-outline'"
    />

    <span>{{ importHint }}</span>
  </div>
</template>
