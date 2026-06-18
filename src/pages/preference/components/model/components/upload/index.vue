<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { appDataDir } from '@tauri-apps/api/path'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { open } from '@tauri-apps/plugin-dialog'
import { copyFile, exists, mkdir, readDir, readTextFile, stat } from '@tauri-apps/plugin-fs'
import { message } from 'antdv-next'
import JSON5 from 'json5'
import { nanoid } from 'nanoid'
import { onMounted, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { ModelMode } from '@/stores/model'

import { INVOKE_KEY } from '@/constants'
import { useModelStore } from '@/stores/model'
import { join } from '@/utils/path'

interface LegacyPetConfig {
  standard?: LegacyStandardConfig
  keyboard?: LegacyKeyboardConfig
  gamepad?: LegacyGamepadConfig
}

interface LegacyStandardConfig {
  hand?: number[][]
}

interface LegacyKeyboardConfig {
  lefthand?: number[][]
  righthand?: number[][]
}

interface LegacyGamepadConfig {
  lefthand?: number[][]
  righthand?: number[][]
}

interface ImportVariant {
  mode: ModelMode
  rootPath: string
  modelPath: string
}

interface KeyImageRef {
  sourceDir: string
  sourceIndex: number
  keyName: string
  hand: 'left' | 'right'
}

const dropRef = useTemplateRef('drop')
const dragenter = ref(false)
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
  192: 'BackQuote',
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

onMounted(() => {
  const appWindow = getCurrentWebviewWindow()

  appWindow.onDragDropEvent(({ payload }) => {
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

async function handleUpload() {
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
  for await (const fromPath of paths) {
    try {
      const importedModels = await importFromPath(fromPath)

      for (const model of importedModels) {
        modelStore.models.push(model)
      }

      message.success(t('pages.preference.model.hints.importSuccess'))
    } catch (error) {
      message.error(String(error))
    }
  }
})

async function importFromPath(fromPath: string) {
  const sourcePath = await prepareImportSource(fromPath)
  const variants = await discoverImportVariants(sourcePath)

  if (!variants.length) {
    throw new Error('No model3.json found')
  }

  const models = []

  for (const variant of variants) {
    const id = nanoid()
    const toPath = join(await appDataDir(), 'custom-models', id)

    await invoke(INVOKE_KEY.COPY_DIR, {
      fromPath: variant.modelPath,
      toPath,
    })

    await normalizeResources(variant, toPath)

    models.push({
      id,
      path: toPath,
      mode: variant.mode,
      isPreset: false,
    })
  }

  return models
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

      variants.push({
        mode,
        rootPath,
        modelPath,
      })
    }
  }

  return variants
}

async function discoverCubismVariants(sourcePath: string) {
  const modelPaths = await findModelDirectories(sourcePath)

  return await Promise.all(modelPaths.map(async (modelPath): Promise<ImportVariant> => ({
    mode: await inferMode(modelPath),
    rootPath: modelPath,
    modelPath,
  })))
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
    const targetDir = join(resourcesPath, item.hand === 'left' ? 'left-keys' : 'right-keys')

    if (!await exists(source)) continue

    await mkdir(targetDir, { recursive: true })
    await copyFile(source, join(targetDir, `${item.keyName}.png`))
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

function getKeyImageRefs(variant: ImportVariant, config: LegacyPetConfig) {
  if (variant.mode === 'gamepad') {
    return getPairedKeyImageRefs(config.gamepad?.lefthand, 'lefthand', 'left', 'gamepad')
      .concat(getPairedKeyImageRefs(config.gamepad?.righthand, 'righthand', 'right', 'gamepad'))
  }

  if (variant.mode === 'keyboard') {
    return getPairedKeyImageRefs(config.keyboard?.lefthand, 'lefthand', 'left', 'keyboard')
      .concat(getPairedKeyImageRefs(config.keyboard?.righthand, 'righthand', 'right', 'keyboard'))
  }

  return getPairedKeyImageRefs(config.standard?.hand, 'hand', 'left', 'keyboard')
}

function getPairedKeyImageRefs(
  groups: number[][] | undefined,
  sourceDir: string,
  hand: 'left' | 'right',
  source: 'keyboard' | 'gamepad',
) {
  const refs: KeyImageRef[] = []

  for (const [sourceIndex, keyCodes] of groups?.entries() ?? []) {
    const keyName = getKeyName(keyCodes, source)

    if (!keyName) continue

    refs.push({
      sourceDir,
      sourceIndex,
      keyName,
      hand,
    })
  }

  return refs
}

function getKeyName(keyCodes: number[], source: 'keyboard' | 'gamepad') {
  const code = keyCodes.at(-1)

  if (code === undefined) return

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
    class="w-full flex flex-col cursor-pointer items-center justify-center gap-4 b-1 b-dashed bg-[--ant-color-fill-quaternary] transition b-border rounded-lg hover:border-primary"
    :class="{ 'border-primary': dragenter }"
    @click="handleUpload"
  >
    <div class="i-solar:upload-square-outline text-12 text-primary" />

    <span>{{ $t('pages.preference.model.hints.clickOrDragToImport') }}</span>
  </div>
</template>
