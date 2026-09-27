// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export type RenderQuality = 'economy' | 'balanced' | 'native'

export function normalizeRenderQuality(value: unknown): RenderQuality {
  return value === 'economy' || value === 'native' ? value : 'balanced'
}

/** Limit render targets independently of model textures and logical window size. */
export function resolveRenderResolution(devicePixelRatio: number, quality: unknown = 'balanced') {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  const normalized = normalizeRenderQuality(quality)
  const limit = normalized === 'economy' ? 1 : normalized === 'balanced' ? 2 : ratio

  return Math.min(ratio, limit)
}

export function resolvePreviewResolution(devicePixelRatio: number) {
  return resolveRenderResolution(devicePixelRatio, 'economy')
}
