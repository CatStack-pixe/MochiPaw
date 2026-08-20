// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/**
 * Game mode changes window activation behavior, not the user's render budget.
 */
export function resolveEffectiveMaxFPS(configuredFPS: number, _gameModeActive: boolean) {
  return configuredFPS
}
