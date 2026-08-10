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

    const capability = await this.adapter.getCapability()

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
    return 'opened-download' as const
  }

  await update.download(onDownloadEvent)
  await adapter.runAfterPersisting(async () => {
    await update.install()

    if (!adapter.isWindows) await adapter.relaunch()
  })

  return 'installed' as const
}
