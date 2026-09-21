// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { DirEntry } from '@tauri-apps/plugin-fs'

import { open, readDir, stat } from '@tauri-apps/plugin-fs'

import type { Model } from '@/stores/model'

import { readImageDimensions } from './imageHeader'
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
const resourceMetricPending = new Map<string, Promise<ModelResourceMetric>>()
const MAX_CACHED_MODELS = 64

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

async function getImageMemoryBytes(path: string) {
  try {
    const file = await open(path, { read: true })
    try {
      const size = await readImageDimensions(file)
      return size ? size.width * size.height * 4 : 0
    } finally {
      await file.close()
    }
  } catch {
    return 0
  }
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
  const pending = resourceMetricPending.get(cacheKey)
  if (pending) return pending
  const cached = resourceMetricCache.get(cacheKey)

  if (cached && !options.force) {
    // Refresh insertion order so repeated active models survive cache eviction.
    resourceMetricCache.delete(cacheKey)
    resourceMetricCache.set(cacheKey, cached)
    return cached
  }

  const request = scanModelResourceMetric(model).then((metric) => {
    resourceMetricCache.delete(cacheKey)
    resourceMetricCache.set(cacheKey, metric)
    while (resourceMetricCache.size > MAX_CACHED_MODELS) {
      resourceMetricCache.delete(resourceMetricCache.keys().next().value!)
    }
    return metric
  }).finally(() => {
    resourceMetricPending.delete(cacheKey)
  })
  resourceMetricPending.set(cacheKey, request)
  return request
}

async function scanModelResourceMetric(model: Model): Promise<ModelResourceMetric> {
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
