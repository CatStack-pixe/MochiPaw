// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export interface NormalizedCursorPosition {
  x: number
  y: number
}

export interface CursorBounds {
  width: number
  height: number
  x: number
  y: number
}

const RELATIVE_MOUSE_RANGE = 240

export const RELATIVE_MOUSE_SENSITIVITY_MIN = 0
export const RELATIVE_MOUSE_SENSITIVITY_MAX = 5
export const RELATIVE_MOUSE_SENSITIVITY_DEFAULT = 0.5

export function normalizeRelativeMouseSensitivity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return RELATIVE_MOUSE_SENSITIVITY_DEFAULT
  }

  return Math.min(RELATIVE_MOUSE_SENSITIVITY_MAX, Math.max(RELATIVE_MOUSE_SENSITIVITY_MIN, value))
}

function clampRatio(value: number) {
  return Math.min(1, Math.max(0, value))
}

export function normalizeCursorPosition(
  cursor: { x: number, y: number },
  bounds: CursorBounds,
): NormalizedCursorPosition {
  return {
    x: clampRatio((cursor.x - bounds.x) / bounds.width),
    y: clampRatio((cursor.y - bounds.y) / bounds.height),
  }
}

export function selectMouseLookBounds(
  windowRelativeMouseLook: boolean,
  windowBounds: CursorBounds | undefined,
  monitorBounds: CursorBounds | undefined,
) {
  return windowRelativeMouseLook ? windowBounds : monitorBounds
}

export function normalizeMouseLookPosition(
  cursor: { x: number, y: number },
  windowRelativeMouseLook: boolean,
  windowBounds: CursorBounds | undefined,
  monitorBounds: CursorBounds | undefined,
): NormalizedCursorPosition | undefined {
  const bounds = selectMouseLookBounds(windowRelativeMouseLook, windowBounds, monitorBounds)

  if (!bounds
    || !Number.isFinite(cursor.x)
    || !Number.isFinite(cursor.y)
    || !Number.isFinite(bounds.x)
    || !Number.isFinite(bounds.y)
    || !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height)
    || bounds.width <= 0
    || bounds.height <= 0) {
    return undefined
  }

  return normalizeCursorPosition(cursor, bounds)
}

export function applyRelativeMouseMovement(
  position: NormalizedCursorPosition,
  dx: number,
  dy: number,
  sensitivity = RELATIVE_MOUSE_SENSITIVITY_DEFAULT,
): NormalizedCursorPosition {
  const multiplier = normalizeRelativeMouseSensitivity(sensitivity)

  // Scale raw deltas before clamping so lower sensitivity still reaches the
  // model's full range and does not alter absolute desktop/menu coordinates.
  return {
    x: clampRatio(position.x + dx * multiplier / RELATIVE_MOUSE_RANGE),
    y: clampRatio(position.y + dy * multiplier / RELATIVE_MOUSE_RANGE),
  }
}

export function mergeRelativeMouseMovement(
  previous: { dx: number, dy: number } | undefined,
  next: { dx: number, dy: number },
) {
  return {
    dx: (previous?.dx ?? 0) + next.dx,
    dy: (previous?.dy ?? 0) + next.dy,
  }
}
