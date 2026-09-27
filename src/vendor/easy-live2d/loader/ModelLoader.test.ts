import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Project tests use the Node test runner through tsx.
import test from 'node:test'

import type { Live2DModel } from '../model/Live2DModel'
import type { CubismSetting } from '../utils/cubismSetting'
import type { TextureLoader } from './TextureLoader'

import { ModelLoader } from './ModelLoader'

class TestWebGL2 {
  drawingBufferWidth = 320
  drawingBufferHeight = 240
}

function fixture() {
  const originalFetch = globalThis.fetch
  const originalGl = globalThis.WebGL2RenderingContext
  const runtime = globalThis as unknown as { Live2DCubismCore?: unknown }
  const originalCore = runtime.Live2DCubismCore
  globalThis.WebGL2RenderingContext = TestWebGL2 as unknown as typeof WebGL2RenderingContext
  runtime.Live2DCubismCore = {
    Version: {
      csmGetVersion: () => 50300,
      csmGetLatestMocVersion: () => 6,
      csmGetMocVersion: () => 6,
    },
  }
  const mutations: string[] = []
  let textureReleases = 0
  const assets = {
    prefixPath: '',
    redirPath: { Motions: {}, Textures: [], Expressions: [] },
    getModelFileName: () => 'model.moc3',
    getExpressionCount: () => 0,
    getPhysicsFileName: () => '',
    getPoseFileName: () => '',
    getUserDataFile: () => '',
    getMotionGroupCount: () => 2,
    getMotionGroupName: (i: number) => i === 0 ? 'first' : 'second',
    getMotionCount: () => 1,
    getMotionFileName: (group: string) => `${group}.motion3.json`,
    getTextureCount: () => 0,
  } as unknown as CubismSetting
  const model = {
    setModelSetting: () => { mutations.push('setting') },
    loadMocModel: () => { mutations.push('moc') },
    setupEffects: () => {},
    setupLayout: () => {},
    loadMotionData: (group: string) => { mutations.push(group) },
    finalizeMotionSetup: () => { mutations.push('motions-ready') },
    initializeRenderer: () => { mutations.push('renderer') },
    setReady: () => { mutations.push('ready') },
    getRuntimeDiagnostics: () => ({}),
  } as unknown as Live2DModel
  const textures = {
    release: () => { textureReleases += 1 },
  } as unknown as TextureLoader
  const loader = new ModelLoader()
  return {
    loader,
    mutations,
    textureReleases: () => textureReleases,
    load: () => loader.load(assets, model, textures, new TestWebGL2() as unknown as WebGL2RenderingContext),
    restore: () => {
      globalThis.fetch = originalFetch
      globalThis.WebGL2RenderingContext = originalGl
      runtime.Live2DCubismCore = originalCore
    },
  }
}

test('cancelling during a MOC request prevents model mutation after the response arrives', async () => {
  const f = fixture()
  let started!: () => void
  const requestStarted = new Promise<void>((resolve) => { started = resolve })
  let finish!: (response: Response) => void
  globalThis.fetch = () => {
    started()
    return new Promise<Response>((resolve) => { finish = resolve })
  }
  try {
    const load = f.load()
    await requestStarted
    f.loader.cancel()
    finish(new Response(new Uint8Array([1])))
    await assert.rejects(load, { name: 'AbortError' })
    assert.deepEqual(f.mutations, ['setting'])
    assert.equal(f.textureReleases(), 1)
  } finally {
    f.restore()
  }
})

test('a failed motion cancels siblings so a late response never touches the released model', async () => {
  const f = fixture()
  let secondStarted!: () => void
  const secondRequest = new Promise<void>((resolve) => { secondStarted = resolve })
  let fail!: (reason: Error) => void
  let finish!: (response: Response) => void
  let siblingSignal: AbortSignal | null | undefined
  globalThis.fetch = async (input, init) => {
    if (input === 'model.moc3') return new Response(new Uint8Array([1]))
    if (input === 'first.motion3.json') {
      return new Promise<Response>((_resolve, reject) => { fail = reject })
    }
    siblingSignal = init?.signal
    secondStarted()
    return new Promise<Response>((resolve) => { finish = resolve })
  }
  try {
    const load = f.load()
    await secondRequest
    fail(new Error('Motion request failed'))
    await assert.rejects(load, /Motion request failed/)
    assert.equal(siblingSignal?.aborted, true)
    finish(new Response(new Uint8Array([1])))
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(f.mutations, ['setting', 'moc'])
    assert.equal(f.textureReleases(), 1)
  } finally {
    f.restore()
  }
})
