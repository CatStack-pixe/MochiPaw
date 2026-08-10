// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export type UpdateDistribution
  = 'windows-installer'
    | 'windows-portable'
    | 'macos'
    | 'appimage'
    | 'deb'
    | 'rpm'
    | 'unknown'

export interface UpdateCapability {
  distribution: UpdateDistribution
  installStrategy: 'native' | 'manual'
}

export type UpdateDownloadEvent
  = { event: 'Started', data: { contentLength?: number } }
    | { event: 'Progress', data: { chunkLength: number } }
    | { event: 'Finished' }

export interface AvailableUpdate {
  body?: string
  currentVersion: string
  date?: string
  version: string
  close: () => Promise<void>
  download: (onEvent?: (event: UpdateDownloadEvent) => void) => Promise<void>
  install: () => Promise<void>
}

export type UpdateCheckResult
  = { status: 'latest' }
    | { status: 'available', capability: UpdateCapability, update: AvailableUpdate }

export interface UpdateCheckAdapter {
  check: () => Promise<AvailableUpdate | null>
  getCapability: () => Promise<UpdateCapability>
}

export interface ApplyUpdateAdapter {
  isWindows: boolean
  openUrl: (url: string) => Promise<unknown>
  relaunch: () => Promise<void>
  runAfterPersisting: (action: () => Promise<void>) => Promise<void>
}

const downloadedUpdates = new WeakSet<AvailableUpdate>()
const installedUpdates = new WeakSet<AvailableUpdate>()

async function closeUpdateResource(update: AvailableUpdate) {
  try {
    await update.close()
  } catch {
    // The updater may already have consumed the resource during installation.
  }
}

export async function disposeUpdate(update: AvailableUpdate) {
  downloadedUpdates.delete(update)
  installedUpdates.delete(update)
  await closeUpdateResource(update)
}

export class UpdateOperationGate {
  private generation = 0

  capture() {
    return this.generation
  }

  invalidateChecks() {
    this.generation += 1
  }

  isCurrent(generation: number) {
    return generation === this.generation
  }
}

export class UpdateCheckCoordinator {
  private activeCheck?: Promise<UpdateCheckResult>

  constructor(private readonly adapter: UpdateCheckAdapter) {}

  check() {
    if (this.activeCheck) return this.activeCheck

    const pending = this.runCheck()
    const shared = pending.finally(() => {
      if (this.activeCheck === shared) this.activeCheck = undefined
    })

    this.activeCheck = shared
    return shared
  }

  private async runCheck(): Promise<UpdateCheckResult> {
    const update = await this.adapter.check()

    if (!update) return { status: 'latest' }

    let capability: UpdateCapability
    try {
      capability = await this.adapter.getCapability()
    } catch (error) {
      await disposeUpdate(update)
      throw error
    }

    return { status: 'available', capability, update }
  }
}

export function getUpdateReleaseUrl(repositoryUrl: string, version: string) {
  const tag = version.startsWith('v') ? version : `v${version}`

  return `${repositoryUrl}/releases/tag/${encodeURIComponent(tag)}`
}

export async function applyUpdate(
  update: AvailableUpdate,
  capability: UpdateCapability,
  repositoryUrl: string,
  adapter: ApplyUpdateAdapter,
  onDownloadEvent?: (event: UpdateDownloadEvent) => void,
) {
  if (capability.installStrategy === 'manual') {
    await adapter.openUrl(getUpdateReleaseUrl(repositoryUrl, update.version))
    await disposeUpdate(update)
    return 'opened-download' as const
  }

  if (!installedUpdates.has(update) && !downloadedUpdates.has(update)) {
    await update.download(onDownloadEvent)
    downloadedUpdates.add(update)
  }

  await adapter.runAfterPersisting(async () => {
    if (!installedUpdates.has(update)) {
      await update.install()
      downloadedUpdates.delete(update)
      installedUpdates.add(update)
      await closeUpdateResource(update)
    }

    if (!adapter.isWindows) await adapter.relaunch()
  })

  return 'installed' as const
}
