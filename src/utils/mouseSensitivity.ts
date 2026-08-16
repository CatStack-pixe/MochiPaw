// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

const MIN_RATIO = 0
const MAX_RATIO = 1
const CENTER_RATIO = 0.5

export const MOUSE_SENSITIVITY_MIN = 0
export const MOUSE_SENSITIVITY_MAX = 200
export const MOUSE_SENSITIVITY_DEFAULT = 100

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function applyMouseSensitivity(ratio: number, sensitivity: number) {
  const normalizedRatio = clamp(Number.isFinite(ratio) ? ratio : CENTER_RATIO, MIN_RATIO, MAX_RATIO)
  const normalizedSensitivity = normalizeMouseSensitivity(sensitivity) / 100

  return clamp(
    CENTER_RATIO + (normalizedRatio - CENTER_RATIO) * normalizedSensitivity,
    MIN_RATIO,
    MAX_RATIO,
  )
}

export function normalizeMouseSensitivity(sensitivity: number) {
  if (!Number.isFinite(sensitivity)) return MOUSE_SENSITIVITY_DEFAULT

  return clamp(sensitivity, MOUSE_SENSITIVITY_MIN, MOUSE_SENSITIVITY_MAX)
}
