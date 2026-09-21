import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Project tests use the Node test runner through tsx.
import test from 'node:test'

import { TimeManager } from './TimeManager'

test('first frame and resumed frame do not simulate elapsed hidden time', () => {
  let now = 10_000
  const time = new TimeManager(() => now)
  time.update()
  assert.equal(time.deltaTime, 0)
  now += 25
  time.update()
  assert.equal(time.deltaTime, 0.025)
  now += 60_000
  time.reset()
  time.update()
  assert.equal(time.deltaTime, 0)
  now += 40
  time.update()
  assert.equal(time.deltaTime, 0.04)
})

test('unexpected stalls and backwards clock samples cannot destabilize model physics', () => {
  let now = 0
  const time = new TimeManager(() => now)
  time.update()
  now = 60_000
  time.update()
  assert.equal(time.deltaTime, 0.1)
  now -= 10
  time.update()
  assert.equal(time.deltaTime, 0)
})
