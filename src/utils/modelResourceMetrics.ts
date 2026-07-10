// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { DirEntry } from '@tauri-apps/plugin-fs'

import { readDir, readFile, stat } from '@tauri-apps/plugin-fs'

import type { Model } from '@/stores/model'

import { join } from './path'

export type ResourceMetricCategory
  = | 'model'
    | 'texture'
    | 'config'
    | 'motion'
    | 'expression'
    | 'physics'
    | 'audio'
    | 'auxiliary'
    | 'other'

export interface ResourceCategoryMetric {
  category: ResourceMetricCategory
  fileCount: number
  fileBytes: number
  estimatedMemoryBytes: number
}

export interface ModelResourceMetric {
  modelId: string
  mode: Model['mode']
  isPreset: boolean
  path: string
  fileCount: number
  fileBytes: number
  estimatedMemoryBytes: number
  categories: ResourceCategoryMetric[]
}

export interface ModelResourceMetricsOptions {
  force?: boolean
  onProgress?: (progress: { scanned: number, total: number }) => void
}

interface ResourceFile {
  path: string
  name: string
  bytes: number
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.wav', '.ogg'])
const resourceMetricCache = new Map<string, ModelResourceMetric>()

function getExtension(name: string) {
  const index = name.lastIndexOf('.')

  return index === -1 ? '' : name.slice(index).toLowerCase()
}

function getCategory(file: ResourceFile): ResourceMetricCategory {
  const name = file.name.toLowerCase()
  const extension = getExtension(name)
  const pathParts = file.path.toLowerCase().split(/[\\/]/)

  if (extension === '.moc3') return 'model'
  if (name === 'background.png' || name === 'cover.png' || pathParts.includes('resources')) return 'auxiliary'
  if (name.endsWith('.motion3.json')) return 'motion'
  if (name.endsWith('.exp3.json')) return 'expression'
  if (name.endsWith('.physics3.json')) return 'physics'
  if (name.endsWith('.json')) return 'config'
  if (IMAGE_EXTENSIONS.has(extension)) return 'texture'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'

  return 'other'
}

async function collectFiles(path: string): Promise<ResourceFile[]> {
  const files: ResourceFile[] = []
  const pending = [path]

  while (pending.length) {
    const currentPath = pending.pop()!
    const entries = await readDir(currentPath).catch(() => [] as DirEntry[])

    for (const entry of entries) {
      const entryPath = join(currentPath, entry.name)

      if (entry.isDirectory) {
        pending.push(entryPath)
        continue
      }

      if (!entry.isFile) continue

      const metadata = await stat(entryPath).catch(() => null)

      files.push({
        path: entryPath,
        name: entry.name,
        bytes: metadata?.size ?? 0,
      })
    }
  }

  return files
}

function readUint24LE(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function getPngSize(bytes: Uint8Array) {
  if (
    bytes.length < 24
    || bytes[0] !== 0x89
    || bytes[1] !== 0x50
    || bytes[2] !== 0x4E
    || bytes[3] !== 0x47
  ) {
    return null
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
  }
}

function getJpegSize(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 2

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xFF) {
      offset += 1
      continue
    }

    const marker = bytes[offset + 1]
    const length = view.getUint16(offset + 2)

    if (length < 2) return null

    if (marker >= 0xC0 && marker <= 0xC3) {
      return {
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
      }
    }

    offset += 2 + length
  }

  return null
}

function getWebpSize(bytes: Uint8Array) {
  if (
    bytes.length < 30
    || String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF'
    || String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP'
  ) {
    return null
  }

  const type = String.fromCharCode(...bytes.slice(12, 16))

  if (type === 'VP8X') {
    return {
      width: readUint24LE(bytes, 24) + 1,
      height: readUint24LE(bytes, 27) + 1,
    }
  }

  if (type === 'VP8 ' && bytes.length >= 30) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    return {
      width: view.getUint16(26, true) & 0x3FFF,
      height: view.getUint16(28, true) & 0x3FFF,
    }
  }

  if (type === 'VP8L' && bytes.length >= 25) {
    const b0 = bytes[21]
    const b1 = bytes[22]
    const b2 = bytes[23]
    const b3 = bytes[24]

    return {
      width: 1 + (((b1 & 0x3F) << 8) | b0),
      height: 1 + ((b3 << 6) | (b2 >> 2) | ((b1 & 0xC0) << 6)),
    }
  }

  return null
}

async function getImageMemoryBytes(path: string) {
  const bytes = await readFile(path).catch(() => null)

  if (!bytes) return 0

  const size = getPngSize(bytes) ?? getJpegSize(bytes) ?? getWebpSize(bytes)

  if (!size) return 0

  return size.width * size.height * 4
}

async function estimateMemoryBytes(file: ResourceFile, category: ResourceMetricCategory) {
  if (category === 'texture') {
    return await getImageMemoryBytes(file.path) || file.bytes
  }

  return file.bytes
}

function getCacheKey(model: Model) {
  return `${model.mode}:${model.id}:${model.path}:${model.isPreset ? 'preset' : 'custom'}`
}

export async function getModelResourceMetric(model: Model, options: ModelResourceMetricsOptions = {}) {
  const cacheKey = getCacheKey(model)
  const cached = resourceMetricCache.get(cacheKey)

  if (cached && !options.force) return cached

  const files = await collectFiles(model.path)
  const categories = new Map<ResourceMetricCategory, ResourceCategoryMetric>()

  for (const file of files) {
    const category = getCategory(file)
    const metric = categories.get(category) ?? {
      category,
      fileCount: 0,
      fileBytes: 0,
      estimatedMemoryBytes: 0,
    }

    metric.fileCount += 1
    metric.fileBytes += file.bytes
    metric.estimatedMemoryBytes += await estimateMemoryBytes(file, category)

    categories.set(category, metric)
  }

  const categoryMetrics = Array.from(categories.values())
  const metric = {
    modelId: model.id,
    mode: model.mode,
    isPreset: model.isPreset,
    path: model.path,
    fileCount: files.length,
    fileBytes: categoryMetrics.reduce((total, item) => total + item.fileBytes, 0),
    estimatedMemoryBytes: categoryMetrics.reduce((total, item) => total + item.estimatedMemoryBytes, 0),
    categories: categoryMetrics,
  }

  resourceMetricCache.set(cacheKey, metric)

  return metric
}

export async function getModelResourceMetrics(models: Model[], options: ModelResourceMetricsOptions = {}) {
  const result: ModelResourceMetric[] = []
  let scanned = 0

  for (const model of models) {
    result.push(await getModelResourceMetric(model, options))
    scanned += 1
    options.onProgress?.({ scanned, total: models.length })
  }

  return result
}
