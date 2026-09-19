// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

interface MouseLookPosition {
  x: number
  y: number
}

interface ParameterRange {
  min: number
  max: number
}

export function mirrorMouseLookPosition(
  position: MouseLookPosition,
  mirrorX = false,
  mirrorY = false,
): MouseLookPosition {
  return {
    x: mirrorX ? 1 - position.x : position.x,
    y: mirrorY ? 1 - position.y : position.y,
  }
}

export function getMouseLookParameterValue(
  axis: 'X' | 'Y' | 'Z',
  { min, max }: ParameterRange,
  position: MouseLookPosition,
): number {
  if (axis === 'Z') {
    // Preserve the existing roll response; mirroring either axis reverses it,
    // while mirroring both axes leaves the product unchanged.
    return (1 - 2 * position.x) * (1 - 2 * position.y) * min
  }

  // Mirror normalized coordinates before mapping into the model's range.
  // Negating a mapped value would only work for ranges centered on zero.
  const ratio = axis === 'X' ? position.x : position.y
  return max - ratio * (max - min)
}
