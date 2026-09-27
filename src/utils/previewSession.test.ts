// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Tests use the project's Node test runner.
import test from 'node:test'

import { PreviewSession } from './previewSession'

test('leaving a preview during renderer initialization disposes the late renderer', async () => {
  const released: string[] = []
  const session = new PreviewSession((error) => {
    throw error
  })
  const rendererReady = Promise.resolve('renderer')
  session.dispose()
  assert.equal(session.own(await rendererReady, value => released.push(value)), false)
  session.dispose()
  assert.deepEqual(released, ['renderer'])
})

test('model cleanup precedes GL context destruction even when cleanup throws', () => {
  const released: string[] = []
  const errors: unknown[] = []
  const session = new PreviewSession(error => errors.push(error))
  session.own('renderer', value => released.push(value))
  session.own('model', (value) => {
    released.push(value)
    throw new Error('model cleanup failed')
  })
  session.dispose()
  session.dispose()
  assert.deepEqual(released, ['model', 'renderer'])
  assert.equal(errors.length, 1)
})

test('an old preview completion cannot release the newly selected preview', () => {
  const released: string[] = []
  const oldSession = new PreviewSession((error) => {
    throw error
  })
  const newSession = new PreviewSession((error) => {
    throw error
  })
  oldSession.dispose()
  newSession.own('new renderer', value => released.push(value))
  oldSession.own('old renderer', value => released.push(value))
  assert.deepEqual(released, ['old renderer'])
  assert.equal(newSession.disposed, false)
  newSession.dispose()
  assert.deepEqual(released, ['old renderer', 'new renderer'])
})
