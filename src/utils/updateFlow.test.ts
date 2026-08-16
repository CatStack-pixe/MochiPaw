import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import type { AvailableUpdate, UpdateCapability, UpdateDownloadEvent } from './updateFlow'

import {
  applyUpdate,
  disposeUpdate,
  fetchGitHubReleaseBody,
  getUpdateReleaseUrl,
  transferUpdateOwnership,
  UpdateCheckCoordinator,
  UpdateOperationGate,
} from './updateFlow'

const nativeCapability: UpdateCapability = {
  distribution: 'appimage',
  installStrategy: 'native',
}

function createUpdate(overrides: Partial<AvailableUpdate> = {}): AvailableUpdate {
  return {
    currentVersion: '1.1.9',
    version: '1.1.10',
    close: async () => {},
    download: async () => {},
    install: async () => {},
    ...overrides,
  }
}

test('shares concurrent update checks', async () => {
  let resolveCheck: ((update: AvailableUpdate | null) => void) | undefined
  let checkCalls = 0
  let capabilityCalls = 0
  const update = createUpdate()
  const coordinator = new UpdateCheckCoordinator({
    check: () => {
      checkCalls += 1
      return new Promise((resolve) => {
        resolveCheck = resolve
      })
    },
    getCapability: async () => {
      capabilityCalls += 1
      return nativeCapability
    },
  })

  const backgroundCheck = coordinator.check()
  const manualCheck = coordinator.check()

  assert.equal(backgroundCheck, manualCheck)
  resolveCheck?.(update)
  assert.deepEqual(await manualCheck, { status: 'available', update, capability: nativeCapability })
  assert.equal(checkCalls, 1)
  assert.equal(capabilityCalls, 1)
})

test('reports the latest version without querying install capability', async () => {
  let capabilityCalls = 0
  const coordinator = new UpdateCheckCoordinator({
    check: async () => null,
    getCapability: async () => {
      capabilityCalls += 1
      return nativeCapability
    },
  })

  assert.deepEqual(await coordinator.check(), { status: 'latest' })
  assert.equal(capabilityCalls, 0)
})

test('returns an available update with its install capability', async () => {
  const update = createUpdate()
  const coordinator = new UpdateCheckCoordinator({
    check: async () => update,
    getCapability: async () => nativeCapability,
  })

  assert.deepEqual(await coordinator.check(), { status: 'available', update, capability: nativeCapability })
})

test('closes the update resource when capability detection fails', async () => {
  let closed = false
  const update = createUpdate({
    close: async () => {
      closed = true
    },
  })
  const coordinator = new UpdateCheckCoordinator({
    check: async () => update,
    getCapability: async () => {
      throw new Error('capability failed')
    },
  })

  await assert.rejects(coordinator.check(), /capability failed/)
  assert.equal(closed, true)
})

test('invalidates checks captured before an update operation starts', () => {
  const gate = new UpdateOperationGate()
  const pendingCheck = gate.capture()

  assert.equal(gate.isCurrent(pendingCheck), true)
  gate.invalidateChecks()
  assert.equal(gate.isCurrent(pendingCheck), false)
  assert.equal(gate.isCurrent(gate.capture()), true)
})

test('transfers UI ownership before asynchronously closing the previous update', async () => {
  let finishClose: (() => void) | undefined
  let closeStarted = false
  const previousUpdate = createUpdate({
    close: () => {
      closeStarted = true
      return new Promise<void>((resolve) => {
        finishClose = resolve
      })
    },
  })
  const nextUpdate = createUpdate({ version: '1.1.11' })
  let ownedUpdate = previousUpdate

  const cleanup = transferUpdateOwnership(previousUpdate, nextUpdate, (update) => {
    ownedUpdate = update
  })

  assert.equal(ownedUpdate, nextUpdate)
  assert.equal(closeStarted, true)
  finishClose?.()
  await cleanup
})

test('forwards download progress before persisting and installing', async () => {
  const order: string[] = []
  const events: UpdateDownloadEvent[] = []
  const update = createUpdate({
    close: async () => {
      order.push('close')
    },
    download: async (onEvent) => {
      order.push('download')
      onEvent?.({ event: 'Started', data: { contentLength: 20 } })
      onEvent?.({ event: 'Progress', data: { chunkLength: 8 } })
      onEvent?.({ event: 'Finished' })
    },
    install: async () => {
      order.push('install')
    },
  })

  await applyUpdate(update, nativeCapability, 'https://example.com/app', {
    isWindows: false,
    openUrl: async () => {},
    relaunch: async () => {
      order.push('relaunch')
    },
    runAfterPersisting: async (action) => {
      order.push('persist')
      await action()
    },
  }, event => events.push(event))

  assert.deepEqual(order, ['download', 'persist', 'install', 'close', 'relaunch'])
  assert.deepEqual(events, [
    { event: 'Started', data: { contentLength: 20 } },
    { event: 'Progress', data: { chunkLength: 8 } },
    { event: 'Finished' },
  ])
})

test('does not persist or install when downloading fails', async () => {
  let persisted = false
  let installed = false
  const update = createUpdate({
    download: async () => {
      throw new Error('download failed')
    },
    install: async () => {
      installed = true
    },
  })

  await assert.rejects(applyUpdate(update, nativeCapability, 'https://example.com/app', {
    isWindows: false,
    openUrl: async () => {},
    relaunch: async () => {},
    runAfterPersisting: async () => {
      persisted = true
    },
  }), /download failed/)
  assert.equal(persisted, false)
  assert.equal(installed, false)
})

test('does not install when persistent store saving fails', async () => {
  let installed = false
  const update = createUpdate({
    install: async () => {
      installed = true
    },
  })

  await assert.rejects(applyUpdate(update, nativeCapability, 'https://example.com/app', {
    isWindows: false,
    openUrl: async () => {},
    relaunch: async () => {},
    runAfterPersisting: async () => {
      throw new Error('save failed')
    },
  }), /save failed/)
  assert.equal(installed, false)
})

test('reuses downloaded bytes when saving fails and the user retries', async () => {
  let downloadCalls = 0
  let persistCalls = 0
  let installCalls = 0
  const update = createUpdate({
    download: async () => {
      downloadCalls += 1
    },
    install: async () => {
      installCalls += 1
    },
  })
  const adapter = {
    isWindows: true,
    openUrl: async () => {},
    relaunch: async () => {},
    runAfterPersisting: async (action: () => Promise<void>) => {
      persistCalls += 1
      if (persistCalls === 1) throw new Error('save failed')
      await action()
    },
  }

  await assert.rejects(applyUpdate(update, nativeCapability, 'https://example.com/app', adapter), /save failed/)
  await applyUpdate(update, nativeCapability, 'https://example.com/app', adapter)

  assert.equal(downloadCalls, 1)
  assert.equal(installCalls, 1)
})

test('allows the persistence guard to resume typing statistics after install failure', async () => {
  const order: string[] = []
  const update = createUpdate({
    install: async () => {
      order.push('install')
      throw new Error('install failed')
    },
  })

  await assert.rejects(applyUpdate(update, nativeCapability, 'https://example.com/app', {
    isWindows: false,
    openUrl: async () => {},
    relaunch: async () => {
      order.push('relaunch')
    },
    runAfterPersisting: async (action) => {
      order.push('persist')
      try {
        await action()
      } catch (error) {
        order.push('resume-typing-stats')
        throw error
      }
    },
  }), /install failed/)
  assert.deepEqual(order, ['persist', 'install', 'resume-typing-stats'])
})

test('reuses downloaded bytes when installation fails and the user retries', async () => {
  let downloadCalls = 0
  let installCalls = 0
  const update = createUpdate({
    download: async () => {
      downloadCalls += 1
    },
    install: async () => {
      installCalls += 1
      if (installCalls === 1) throw new Error('install failed')
    },
  })
  const adapter = {
    isWindows: true,
    openUrl: async () => {},
    relaunch: async () => {},
    runAfterPersisting: async (action: () => Promise<void>) => action(),
  }

  await assert.rejects(applyUpdate(update, nativeCapability, 'https://example.com/app', adapter), /install failed/)
  await applyUpdate(update, nativeCapability, 'https://example.com/app', adapter)

  assert.equal(downloadCalls, 1)
  assert.equal(installCalls, 2)
})

test('opens the matching release for distributions that require manual installation', async () => {
  const order: string[] = []
  const update = createUpdate({
    close: async () => {
      order.push('close')
    },
    download: async () => {
      order.push('download')
    },
    install: async () => {
      order.push('install')
    },
  })

  const result = await applyUpdate(update, {
    distribution: 'windows-portable',
    installStrategy: 'manual',
  }, 'https://example.com/app', {
    isWindows: true,
    openUrl: async url => order.push(`open:${url}`),
    relaunch: async () => {
      order.push('relaunch')
    },
    runAfterPersisting: async () => {
      order.push('persist')
    },
  })

  assert.equal(result, 'opened-download')
  assert.deepEqual(order, ['open:https://example.com/app/releases/tag/v1.1.10', 'close'])
  assert.equal(getUpdateReleaseUrl('https://example.com/app', 'v1.1.10'), 'https://example.com/app/releases/tag/v1.1.10')
})

test('lets the Windows installer own process restart after state is saved', async () => {
  const order: string[] = []
  const update = createUpdate({
    close: async () => {
      order.push('close')
    },
    download: async () => {
      order.push('download')
    },
    install: async () => {
      order.push('install')
    },
  })

  await applyUpdate(update, {
    distribution: 'windows-installer',
    installStrategy: 'native',
  }, 'https://example.com/app', {
    isWindows: true,
    openUrl: async () => {},
    relaunch: async () => {
      order.push('relaunch')
    },
    runAfterPersisting: async (action) => {
      order.push('persist')
      await action()
    },
  })

  assert.deepEqual(order, ['download', 'persist', 'install', 'close'])
})

test('loads GitHub release notes when updater metadata is empty', async () => {
  let requestedUrl = ''
  const fetcher: typeof fetch = async (input) => {
    requestedUrl = String(input)
    return new Response(JSON.stringify({ body: '## What is new\n\n- Embedded timer' }), {
      headers: { 'content-type': 'application/json' },
    })
  }

  assert.equal(
    await fetchGitHubReleaseBody('https://github.com/CatStack-pixe/MochiPaw', '1.1.10', fetcher),
    '## What is new\n\n- Embedded timer',
  )
  assert.equal(requestedUrl, 'https://api.github.com/repos/CatStack-pixe/MochiPaw/releases/tags/v1.1.10')
})

test('ignores unavailable or non-GitHub release note sources', async () => {
  const fetcher: typeof fetch = async () => new Response('', { status: 404 })

  assert.equal(await fetchGitHubReleaseBody('https://example.com/MochiPaw', '1.1.10', fetcher), '')
  assert.equal(await fetchGitHubReleaseBody('https://github.com/CatStack-pixe/MochiPaw', '1.1.10', fetcher), '')
})

test('disposal ignores close failures after clearing retry state', async () => {
  const update = createUpdate({
    close: async () => {
      throw new Error('already closed')
    },
  })

  await assert.doesNotReject(disposeUpdate(update))
})
