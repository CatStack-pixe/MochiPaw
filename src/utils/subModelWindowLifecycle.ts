// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export interface LifecycleCancellation {
  promise: Promise<void>
  dispose: () => void
}

export class SubModelWindowLifecycle {
  private readonly generations = new Map<string, number>()
  private readonly cancellationResolvers = new Map<string, Set<() => void>>()

  begin(instanceId: string) {
    const generation = (this.generations.get(instanceId) ?? 0) + 1
    this.generations.set(instanceId, generation)

    const resolvers = this.cancellationResolvers.get(instanceId)
    if (resolvers) {
      for (const resolve of resolvers) resolve()
      this.cancellationResolvers.delete(instanceId)
    }

    return generation
  }

  isCurrent(instanceId: string, generation: number) {
    return this.generations.get(instanceId) === generation
  }

  onChange(instanceId: string, generation: number): LifecycleCancellation {
    if (!this.isCurrent(instanceId, generation)) {
      return {
        promise: Promise.resolve(),
        dispose() {},
      }
    }

    let resolveCancellation!: () => void
    const promise = new Promise<void>((resolve) => {
      resolveCancellation = resolve
    })
    const resolvers = this.cancellationResolvers.get(instanceId) ?? new Set<() => void>()
    resolvers.add(resolveCancellation)
    this.cancellationResolvers.set(instanceId, resolvers)

    return {
      promise,
      dispose: () => {
        const currentResolvers = this.cancellationResolvers.get(instanceId)
        if (!currentResolvers) return

        currentResolvers.delete(resolveCancellation)
        if (!currentResolvers.size) this.cancellationResolvers.delete(instanceId)
      },
    }
  }
}
