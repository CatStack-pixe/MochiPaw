import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

test('Windows bundles include a repairable WebView2 runtime bootstrapper', async () => {
  const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.windows.conf.json', import.meta.url), 'utf8'))
  const windows = config.bundle.windows

  assert.deepEqual(windows.webviewInstallMode, {
    type: 'embedBootstrapper',
    silent: true,
  })
  assert.equal(windows.minimumWebview2Version, '110.0.1531.0')
  assert.equal(windows.nsis.installMode, 'both')
})
