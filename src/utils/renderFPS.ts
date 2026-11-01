// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/**
 * Game mode changes window activation behavior, not the user's render budget.
 */
export function resolveEffectiveMaxFPS(configuredFPS: number, _gameModeActive: boolean) {
  return configuredFPS
}

export function resolveOverlayRenderFPS(
  configuredFPS: number,
  gameModeActive: boolean,
  overlayEnabled: boolean,
  overlayTargetFPS: 60 | 90 | 120,
) {
  if (!gameModeActive || !overlayEnabled) return configuredFPS

  return Math.min(configuredFPS, overlayTargetFPS)
}
