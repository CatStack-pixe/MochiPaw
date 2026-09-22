import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Project tests use the Node test runner through tsx.
import test from 'node:test'

// @pixi/sound probes window during module initialization. The lifecycle tests
// never create an audio context/model; select its unsupported-audio path only
// while importing, then restore the Node environment.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
Object.defineProperty(globalThis, 'window', { value: {}, configurable: true })
Object.defineProperty(globalThis, 'document', {
  value: { createElement: () => ({ canPlayType: () => '' }) },
  configurable: true,
})
let spriteModule: typeof import('./Live2DSprite')
try {
  spriteModule = await import('./Live2DSprite')
} finally {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else Reflect.deleteProperty(globalThis, 'document')
}
const { Live2DSprite } = spriteModule

type LifecycleHarness = {
  initCubism: () => void | Promise<void>
  initModel: () => Promise<void>
  initInteraction: () => void
  renderFrame: (renderer: unknown) => Promise<void>
  _modelLoader: { cancel: () => void } | null
  _textureLoader: { release: () => void } | null
  _model: { release: () => void } | null
}

test('destroying before readiness settles the promise and releases resources once in dependency order', async () => {
  const sprite = new Live2DSprite()
  const harness = sprite as unknown as LifecycleHarness
  const released: string[] = []
  harness._modelLoader = { cancel: () => { released.push('cancel') } }
  harness._textureLoader = { release: () => { released.push('textures') } }
  harness._model = { release: () => { released.push('model') } }
  const ready = assert.rejects(sprite.ready, { name: 'AbortError' })
  sprite.destroy()
  sprite.destroy()
  await ready
  assert.deepEqual(released, ['cancel', 'textures', 'model'])
  assert.equal(sprite.destroyed, true)
  assert.equal(sprite.onRender, null)
})

test('a pending initialization finishing after destroy never attaches interaction or emits ready', async () => {
  const sprite = new Live2DSprite()
  const harness = sprite as unknown as LifecycleHarness
  let finish!: () => void
  let interactions = 0
  let readyEvents = 0
  harness.initCubism = () => {}
  harness.initModel = () => new Promise<void>((resolve) => { finish = resolve })
  harness.initInteraction = () => { interactions += 1 }
  sprite.onLive2D('ready', () => { readyEvents += 1 })
  const ready = assert.rejects(sprite.ready, { name: 'AbortError' })
  const frame = harness.renderFrame({})
  await Promise.resolve()
  sprite.destroy()
  finish()
  await frame
  await ready
  assert.equal(interactions, 0)
  assert.equal(readyEvents, 0)
})

test('initialization failure releases resources without falling through to rendering', async () => {
  const sprite = new Live2DSprite()
  const harness = sprite as unknown as LifecycleHarness
  let releases = 0
  harness.initCubism = () => {}
  harness.initModel = async () => { throw new Error('Resource failed') }
  harness._textureLoader = { release: () => { releases += 1 } }
  const ready = assert.rejects(sprite.ready, /Resource failed/)
  await harness.renderFrame({})
  await ready
  sprite.destroy()
  assert.equal(releases, 1)
})

test('a sprite destroyed while waiting for Core never starts loading model resources', async () => {
  const sprite = new Live2DSprite()
  const harness = sprite as unknown as LifecycleHarness
  let finish!: () => void
  let modelLoads = 0
  harness.initCubism = () => new Promise<void>((resolve) => { finish = resolve })
  harness.initModel = async () => { modelLoads += 1 }
  const ready = assert.rejects(sprite.ready, { name: 'AbortError' })
  const frame = harness.renderFrame({})
  sprite.destroy()
  finish()
  await frame
  await ready
  assert.equal(modelLoads, 0)
})
