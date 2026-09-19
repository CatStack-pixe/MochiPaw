// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { getAppDataDirectory } from './appData'

test('uses the backend data root for Windows paths without rewriting Unicode or spaces', async () => {
  const commands: string[] = []
  const root = 'D:\\便携程序\\Mochi Paw\\data'

  const directory = await getAppDataDirectory(async (command) => {
    commands.push(command)
    return root
  })

  assert.equal(directory, root)
  assert.deepEqual(commands, ['get_app_data_directory'])
})

test('retains the backend platform-specific root on non-Windows systems', async () => {
  for (const root of [
    '/home/user/.local/share/net.example.app',
    '/Users/user/Library/Application Support/net.example.app',
  ]) {
    assert.equal(await getAppDataDirectory(async () => root), root)
  }
})

test('propagates storage errors without requesting an alternate directory', async () => {
  const commands: string[] = []
  const error = new Error('The application data directory is not writable')

  await assert.rejects(getAppDataDirectory(async (command) => {
    commands.push(command)
    throw error
  }), actual => actual === error)

  assert.deepEqual(commands, ['get_app_data_directory'])
})
