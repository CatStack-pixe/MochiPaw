import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import {
  collectCubismResourceReferences,
  createCubismFingerprint,
  isCurrentCubismFingerprint,
  resolveCubismFingerprint,
} from './modelFingerprint'

const modelFile = '/models/cat.model3.json'

function references() {
  return collectCubismResourceReferences(modelFile, {
    FileReferences: {
      Moc: 'cat.moc3',
      Textures: ['texture.png'],
      Physics: 'cat.physics3.json',
      DisplayInfo: 'cat.cdi3.json',
      Expressions: [{ File: 'happy.exp3.json' }],
      Motions: { Idle: [{ File: 'idle.motion3.json', Sound: 'idle.wav' }] },
      Pose: 'cat.pose3.json',
      UserData: 'cat.userdata3.json',
    },
  })
}

test('collects optional Cubism resources and skips absent references', () => {
  const keys = references().map(resource => resource.key)

  assert.deepEqual(keys, [
    'model:cat.model3.json',
    'moc:cat.moc3',
    'physics:cat.physics3.json',
    'displayInfo:cat.cdi3.json',
    'pose:cat.pose3.json',
    'userData:cat.userdata3.json',
    'texture:texture.png',
    'expression:happy.exp3.json',
    'motion:Idle:idle.motion3.json',
    'motionSound:Idle:idle.wav',
  ])
})

test('fingerprint changes when motion, expression, or sound content changes', async () => {
  const original = new Map(references().map(resource => [resource.path, new TextEncoder().encode(resource.key)]))
  const fingerprint = async (changes: Record<string, string> = {}) => {
    const files = new Map(original)
    for (const [path, content] of Object.entries(changes)) {
      files.set(path, new TextEncoder().encode(content))
    }
    return await createCubismFingerprint('standard', references(), async path => files.get(path))
  }
  const first = await fingerprint()
  assert.equal(await fingerprint(), first)

  const changedMotion = await fingerprint({ '/models/idle.motion3.json': 'changed' })
  assert.notEqual(changedMotion, first)

  const changedExpression = await fingerprint({ '/models/happy.exp3.json': 'changed' })
  assert.notEqual(changedExpression, first)

  const changedSound = await fingerprint({ '/models/idle.wav': 'changed' })
  assert.notEqual(changedSound, first)
})

test('missing optional files produce a stable fingerprint', async () => {
  const fingerprint = () => createCubismFingerprint('keyboard', references(), async () => undefined)

  assert.equal(await fingerprint(), await fingerprint())
})

test('fingerprint version identifies current and legacy cache values', () => {
  assert.equal(isCurrentCubismFingerprint('v2:standard:abc'), true)
  assert.equal(isCurrentCubismFingerprint('standard:abc'), false)
  assert.equal(isCurrentCubismFingerprint(undefined), false)
})

test('recalculates legacy fingerprints and reuses current fingerprints', async () => {
  let calculations = 0
  const calculate = async () => {
    calculations += 1
    return 'v2:standard:calculated'
  }

  assert.equal(await resolveCubismFingerprint('standard:legacy', calculate), 'v2:standard:calculated')
  assert.equal(calculations, 1)
  assert.equal(await resolveCubismFingerprint('v2:standard:cached', calculate), 'v2:standard:cached')
  assert.equal(calculations, 1)
})
