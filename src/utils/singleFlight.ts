// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export function createSingleFlightRunner<T extends string>() {
  const inFlight = new Set<T>()

  function run(command: T, operation: () => Promise<unknown>) {
    if (inFlight.has(command)) return undefined

    inFlight.add(command)
    return Promise.resolve().then(operation).finally(() => {
      inFlight.delete(command)
    })
  }

  return { run }
}
