import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Project tests use the Node test runner through tsx.
import test from 'node:test'

import { CubismShader_WebGL } from '../Framework/rendering/cubismshader_webgl'

function shaderHarness() {
  // Isolate async resource ownership from shader compilation/Core constants.
  const shader = Object.create(CubismShader_WebGL.prototype) as CubismShader_WebGL
  let finish!: () => void
  let loads = 0
  let registrations = 0
  let releases = 0
  Object.assign(shader, {
    _released: false,
    _shaderCount: 0,
    _shaderSets: [],
    loadShaders: () => {
      loads += 1
      return new Promise<void>((resolve) => { finish = resolve })
    },
    registerShader: () => { registrations += 1 },
    registerBlendShader: () => { registrations += 1 },
    releaseShaderProgram: () => { releases += 1 },
  })
  return {
    shader,
    finish: () => finish(),
    loads: () => loads,
    registrations: () => registrations,
    releases: () => releases,
  }
}

test('shader source completion after release cannot register new GPU programs', async () => {
  const f = shaderHarness()
  f.shader.generateShaders()
  f.shader.release()
  f.shader.release()
  f.finish()
  await new Promise<void>(resolve => setImmediate(resolve))
  f.shader.generateShaders()
  assert.equal(f.loads(), 1)
  assert.equal(f.registrations(), 0)
  assert.equal(f.releases(), 1)
})

test('releasing one context does not cancel another contexts pending shader load', async () => {
  const disposed = shaderHarness()
  const active = shaderHarness()
  disposed.shader.generateShaders()
  active.shader.generateShaders()
  disposed.shader.release()
  disposed.finish()
  active.finish()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(disposed.registrations(), 0)
  assert.equal(active.registrations(), 2)
  active.shader.release()
})
