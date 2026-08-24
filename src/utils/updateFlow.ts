// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { logDebug, logError, logInfo, logWarn } from '@/utils/diagnostics'

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
    logWarn('[update] failed to close updater resource', { version: update.version })
  }
}

export async function disposeUpdate(update: AvailableUpdate) {
  downloadedUpdates.delete(update)
  installedUpdates.delete(update)
  await closeUpdateResource(update)
}

export function transferUpdateOwnership(
  currentUpdate: AvailableUpdate | undefined,
  nextUpdate: AvailableUpdate,
  assign: (update: AvailableUpdate) => void,
) {
  assign(nextUpdate)

  return currentUpdate && currentUpdate !== nextUpdate
    ? disposeUpdate(currentUpdate)
    : Promise.resolve()
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
    logDebug('[update] updater check request started')
    const update = await this.adapter.check()

    if (!update) {
      logInfo('[update] updater reports latest version')
      return { status: 'latest' }
    }

    let capability: UpdateCapability
    try {
      capability = await this.adapter.getCapability()
    } catch (error) {
      await disposeUpdate(update)
      logError('[update] capability detection failed', { version: update.version, error })
      throw error
    }

    logInfo('[update] update available', {
      version: update.version,
      currentVersion: update.currentVersion,
      distribution: capability.distribution,
      installStrategy: capability.installStrategy,
    })
    return { status: 'available', capability, update }
  }
}

export function getUpdateReleaseUrl(repositoryUrl: string, version: string) {
  const tag = version.startsWith('v') ? version : `v${version}`

  return `${repositoryUrl}/releases/tag/${encodeURIComponent(tag)}`
}

/** Read the authoritative release body when updater metadata has no notes. */
export async function fetchGitHubReleaseBody(
  repositoryUrl: string,
  version: string,
  fetcher: typeof fetch = fetch,
) {
  try {
    const repository = new URL(repositoryUrl)
    if (repository.hostname.toLowerCase() !== 'github.com') return ''

    const segments = repository.pathname.split('/').filter(Boolean)
    if (segments.length !== 2) return ''

    const tag = version.startsWith('v') ? version : `v${version}`
    const endpoint = `https://api.github.com/repos/${segments.map(encodeURIComponent).join('/')}/releases/tags/${encodeURIComponent(tag)}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5_000)
    let response: Response
    try {
      response = await fetcher(endpoint, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      logWarn('[update] release notes request returned non-success status', {
        version,
        endpoint,
        status: response.status,
      })
      return ''
    }

    const payload: unknown = await response.json()
    if (!payload || typeof payload !== 'object' || typeof (payload as { body?: unknown }).body !== 'string') {
      return ''
    }

    return (payload as { body: string }).body
  } catch (error) {
    logWarn('[update] release notes request failed', { version, error })
    return ''
  }
}

export async function applyUpdate(
  update: AvailableUpdate,
  capability: UpdateCapability,
  repositoryUrl: string,
  adapter: ApplyUpdateAdapter,
  onDownloadEvent?: (event: UpdateDownloadEvent) => void,
) {
  if (capability.installStrategy === 'manual') {
    logInfo('[update] opening manual download', { version: update.version, distribution: capability.distribution })
    await adapter.openUrl(getUpdateReleaseUrl(repositoryUrl, update.version))
    await disposeUpdate(update)
    return 'opened-download' as const
  }

  if (!installedUpdates.has(update) && !downloadedUpdates.has(update)) {
    logInfo('[update] downloading update', { version: update.version })
    await update.download(onDownloadEvent)
    downloadedUpdates.add(update)
  }

  await adapter.runAfterPersisting(async () => {
    if (!installedUpdates.has(update)) {
      logInfo('[update] installing downloaded update', { version: update.version })
      await update.install()
      downloadedUpdates.delete(update)
      installedUpdates.add(update)
      await closeUpdateResource(update)
    }

    if (!adapter.isWindows) {
      logInfo('[update] relaunching after installation', { version: update.version })
      await adapter.relaunch()
    }
  })

  return 'installed' as const
}
