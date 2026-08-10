import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import type { AvailableUpdate, UpdateCapability, UpdateDownloadEvent } from './updateFlow'

import { applyUpdate, getUpdateReleaseUrl, UpdateCheckCoordinator } from './updateFlow'

const nativeCapability: UpdateCapability = {
  distribution: 'appimage',
  installStrategy: 'native',
}

function createUpdate(overrides: Partial<AvailableUpdate> = {}): AvailableUpdate {
  return {
    currentVersion: '1.1.9',
    version: '1.1.10',
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

test('forwards download progress before persisting and installing', async () => {
  const order: string[] = []
  const events: UpdateDownloadEvent[] = []
  const update = createUpdate({
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

  assert.deepEqual(order, ['download', 'persist', 'install', 'relaunch'])
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

test('opens the matching release for distributions that require manual installation', async () => {
  const order: string[] = []
  const update = createUpdate({
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
  assert.deepEqual(order, ['open:https://example.com/app/releases/tag/v1.1.10'])
  assert.equal(getUpdateReleaseUrl('https://example.com/app', 'v1.1.10'), 'https://example.com/app/releases/tag/v1.1.10')
})

test('lets the Windows installer own process restart after state is saved', async () => {
  const order: string[] = []
  const update = createUpdate({
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

  assert.deepEqual(order, ['download', 'persist', 'install'])
})
