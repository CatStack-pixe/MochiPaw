import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import { it } from 'node:test'

import { getSubModelWindowLabel } from './subModelWindow'

it('builds the stable submodel window label', () => {
  assert.equal(getSubModelWindowLabel('test-instance'), 'sub-model-test-instance')
})
