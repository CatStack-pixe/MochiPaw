import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { extractTemporaryImportSource, useImportSource } from './modelImportSource'

for (const outcome of ['imported', 'duplicate'] as const) {
  test(`cleans a ZIP source after an ${outcome} result`, async () => {
    const cleaned: string[] = []
    const result = await useImportSource(
      { path: '/temp/import', temporaryDirectory: '/temp/import' },
      async () => outcome,
      async (path) => {
        cleaned.push(path)
      },
      () => undefined,
    )

    assert.equal(result, outcome)
    assert.deepEqual(cleaned, ['/temp/import'])
  })
}

for (const failure of ['parse failed', 'copy failed']) {
  test(`cleans a ZIP source when ${failure}`, async () => {
    const cleaned: string[] = []

    await assert.rejects(useImportSource(
      { path: '/temp/import', temporaryDirectory: '/temp/import' },
      async () => {
        throw new Error(failure)
      },
      async (path) => {
        cleaned.push(path)
      },
      () => undefined,
    ), new RegExp(failure))
    assert.deepEqual(cleaned, ['/temp/import'])
  })
}

test('cleans partial extraction and preserves the extraction error', async () => {
  const cleaned: string[] = []

  await assert.rejects(extractTemporaryImportSource(
    '/models/cat.zip',
    '/temp/import',
    async () => {
      throw new Error('extract failed')
    },
    async (path) => {
      cleaned.push(path)
    },
    () => undefined,
  ), /extract failed/)
  assert.deepEqual(cleaned, ['/temp/import'])
})

test('does not clean user-selected directories', async () => {
  const cleaned: string[] = []

  await useImportSource(
    { path: '/models/cat' },
    async () => undefined,
    async (path) => {
      cleaned.push(path)
    },
    () => undefined,
  )
  assert.deepEqual(cleaned, [])
})

test('cleanup failures are warnings and do not replace import results', async () => {
  const warnings: unknown[] = []
  const result = await useImportSource(
    { path: '/temp/import', temporaryDirectory: '/temp/import' },
    async () => 'imported',
    async () => {
      throw new Error('cleanup failed')
    },
    (error) => {
      warnings.push(error)
    },
  )

  assert.equal(result, 'imported')
  assert.equal(warnings.length, 1)
})
