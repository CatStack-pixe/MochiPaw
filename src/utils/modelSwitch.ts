// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

interface ModelSwitchTransactionOperations {
  loadTarget: () => void | Promise<void>
  commitSelection: () => void | Promise<void>
  persistSelection: () => void | Promise<void>
  rollbackSelection: (selectionCommitted: boolean) => void | Promise<void>
  restorePrevious: () => void | Promise<void>
}

export async function executeModelSwitchTransaction(operations: ModelSwitchTransactionOperations) {
  let selectionCommitted = false

  try {
    await operations.loadTarget()
    await operations.commitSelection()
    selectionCommitted = true
    await operations.persistSelection()

    return { accepted: true as const }
  } catch (error) {
    try {
      await operations.rollbackSelection(selectionCommitted)
    } catch {
      // Preserve the original switching error while still restoring the renderer.
    }

    try {
      await operations.restorePrevious()
    } catch {
      // The original switching error remains the actionable failure for the caller.
    }

    return {
      accepted: false as const,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
