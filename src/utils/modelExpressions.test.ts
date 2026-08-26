import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Project tests use the Node test runner through tsx.
import test from 'node:test'

import { readExpressionsFromModelJSON } from './modelExpressions'

test('reads expression entries from a model JSON document', () => {
  assert.deepEqual(
    readExpressionsFromModelJSON({
      FileReferences: {
        Expressions: [
          { Name: 'Happy', File: 'happy.exp3.json' },
          { File: 'sad.exp3.json' },
          {},
        ],
      },
    }),
    [
      { name: 'Happy' },
      { name: 'sad' },
      { name: 'Expression 3' },
    ],
  )
})

test('returns no expressions when the model JSON has no expression references', () => {
  assert.deepEqual(readExpressionsFromModelJSON({}), [])
})
