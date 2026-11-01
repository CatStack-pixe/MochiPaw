// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { OverlayTargetFPS } from '@/stores/cat'

export type OverlayBackend = 'desktop' | 'gamebar'

export interface OverlayRenderState {
  sessionId: string
  backend: OverlayBackend
  targetFPS: OverlayTargetFPS
  visible: boolean
  clickThrough: boolean
  opacity: number
  modelId?: string
  modelScale: number
  stateSequence: number
}

export function clampOverlayRefreshRate(refreshRate: number | undefined) {
  if (!Number.isFinite(refreshRate) || !refreshRate || refreshRate <= 0) return 60

  return Math.min(240, Math.round(refreshRate))
}

export function resolveOverlayFPS(targetFPS: OverlayTargetFPS, refreshRate?: number) {
  return Math.min(targetFPS, clampOverlayRefreshRate(refreshRate))
}

export function isOverlayFrameDue(
  previousFrameAt: number | undefined,
  now: number,
  targetFPS: OverlayTargetFPS,
) {
  if (previousFrameAt === undefined) return true

  return now - previousFrameAt >= 1000 / targetFPS
}
