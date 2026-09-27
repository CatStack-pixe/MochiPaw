// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/** Owns one preview load, including resources acquired after it was cancelled. */
export class PreviewSession {
  private releases: Array<() => void> = []
  public disposed = false

  constructor(private readonly onError: (error: unknown) => void) {}

  own<T>(resource: T, release: (resource: T) => void) {
    if (this.disposed) {
      this.release(() => release(resource))
      return false
    }

    this.releases.push(() => release(resource))
    return true
  }

  dispose() {
    if (this.disposed) return

    this.disposed = true
    // Destroy the model before the renderer that owns its GL context.
    for (const release of this.releases.reverse()) this.release(release)
    this.releases = []
  }

  private release(release: () => void) {
    try {
      release()
    } catch (error) {
      this.onError(error)
    }
  }
}
