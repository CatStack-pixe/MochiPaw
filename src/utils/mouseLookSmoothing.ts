// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export const MOUSE_LOOK_SMOOTHING_MIN = 0
export const MOUSE_LOOK_SMOOTHING_MAX = 100
export const MOUSE_LOOK_SMOOTHING_DEFAULT = 75
export const MOUSE_LOOK_WINDOW_RELATIVE_DEFAULT = false
export const MOUSE_LOOK_DAMPING_DECAY_DEFAULT = 0.75
export const MOUSE_LOOK_DAMPING_DECAY_MAX = 0.95

const MOUSE_LOOK_SMOOTHING_REFERENCE = 75
const FRAME_DURATION_MS = 1000 / 60

export interface MouseLookSmoothingSettings {
  windowRelativeMouseLook: boolean
  mouseLookSmoothing: number
  legacyMouseLookSmoothing: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function normalizeMouseLookSmoothing(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MOUSE_LOOK_SMOOTHING_DEFAULT

  return clamp(value, MOUSE_LOOK_SMOOTHING_MIN, MOUSE_LOOK_SMOOTHING_MAX)
}

export function getMouseLookDampingDecay(value: unknown) {
  const smoothing = normalizeMouseLookSmoothing(value)

  if (smoothing <= MOUSE_LOOK_SMOOTHING_REFERENCE) {
    return smoothing / 100
  }

  const extraSmoothing = (smoothing - MOUSE_LOOK_SMOOTHING_REFERENCE)
    / (MOUSE_LOOK_SMOOTHING_MAX - MOUSE_LOOK_SMOOTHING_REFERENCE)

  return MOUSE_LOOK_DAMPING_DECAY_DEFAULT
    + extraSmoothing * (MOUSE_LOOK_DAMPING_DECAY_MAX - MOUSE_LOOK_DAMPING_DECAY_DEFAULT)
}

export function getMouseLookInterpolationAlpha(value: unknown, deltaMS: number) {
  const dampingDecay = getMouseLookDampingDecay(value)
  const frameDelta = Number.isFinite(deltaMS)
    ? Math.max(0, deltaMS) / FRAME_DURATION_MS
    : 1

  if (dampingDecay === 0) return 1

  return 1 - dampingDecay ** frameDelta
}

export function getActiveMouseLookSmoothing(settings: MouseLookSmoothingSettings) {
  const value = settings.windowRelativeMouseLook
    ? settings.mouseLookSmoothing
    : settings.legacyMouseLookSmoothing

  return normalizeMouseLookSmoothing(value)
}

export function setActiveMouseLookSmoothing(settings: MouseLookSmoothingSettings, value: unknown) {
  const normalized = normalizeMouseLookSmoothing(value)

  if (settings.windowRelativeMouseLook) {
    settings.mouseLookSmoothing = normalized
  } else {
    settings.legacyMouseLookSmoothing = normalized
  }

  return normalized
}
