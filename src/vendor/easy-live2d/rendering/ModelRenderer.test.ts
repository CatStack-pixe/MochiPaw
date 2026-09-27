import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Project tests use the Node test runner through tsx.
import test from 'node:test'

import type { TimeManager } from '../core/TimeManager'
import type { Live2DModel } from '../model/Live2DModel'
import { CubismMatrix44 } from '@Framework/math/cubismmatrix44'

import { Config } from '../utils/config'
import { ViewTransform } from './ViewTransform'
import { ModelRenderer } from './ModelRenderer'

function modelHarness(draw: (matrix: CubismMatrix44) => void = () => {}) {
  return {
    isReady: true,
    getModel: () => ({}),
    update: () => {},
    draw: (matrix: CubismMatrix44) => draw(matrix),
  } as unknown as Live2DModel
}

function glHarness() {
  let errors = 0
  let viewportCalls = 0
  const constants = [
    'VIEWPORT', 'SCISSOR_BOX', 'COLOR_CLEAR_VALUE', 'COLOR_WRITEMASK', 'DEPTH_CLEAR_VALUE',
    'FRAMEBUFFER_BINDING', 'ARRAY_BUFFER_BINDING', 'ELEMENT_ARRAY_BUFFER_BINDING',
    'BLEND_SRC_RGB', 'BLEND_DST_RGB', 'BLEND_SRC_ALPHA', 'BLEND_DST_ALPHA',
    'BLEND_EQUATION_RGB', 'BLEND_EQUATION_ALPHA', 'DEPTH_FUNC', 'DEPTH_WRITEMASK',
    'STENCIL_FUNC', 'STENCIL_REF', 'STENCIL_VALUE_MASK', 'STENCIL_WRITEMASK',
    'STENCIL_FAIL', 'STENCIL_PASS_DEPTH_FAIL', 'STENCIL_PASS_DEPTH_PASS',
    'ACTIVE_TEXTURE', 'CURRENT_PROGRAM', 'NO_ERROR', 'FRAMEBUFFER', 'SCISSOR_TEST',
    'DEPTH_TEST', 'BLEND', 'CULL_FACE', 'STENCIL_TEST',
    'FRONT_FACE', 'ARRAY_BUFFER', 'ELEMENT_ARRAY_BUFFER', 'LEQUAL',
    'DEPTH_BUFFER_BIT', 'SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA',
  ]
  const gl = {
    drawingBufferWidth: 100,
    drawingBufferHeight: 100,
    getParameter: (name: number) => {
      if (name === gl.VIEWPORT) return new Int32Array([0, 0, 100, 100])
      if (name === gl.SCISSOR_BOX) return new Int32Array([0, 0, 100, 100])
      if (name === gl.COLOR_CLEAR_VALUE) return new Float32Array([0, 0, 0, 0])
      if (name === gl.DEPTH_WRITEMASK) return true
      if (name === gl.COLOR_WRITEMASK) return [true, true, true, true]
      if (name === gl.DEPTH_CLEAR_VALUE) return 1
      if (name === gl.ACTIVE_TEXTURE) return 0
      if (name === gl.NO_ERROR) return 0
      return 0
    },
    isEnabled: () => false,
    getError: () => { errors += 1; return 0 },
    viewport: () => { viewportCalls += 1 },
    scissor: () => {},
    clearColor: () => {},
    clearDepth: () => {},
    clear: () => {},
    enable: () => {},
    disable: () => {},
    frontFace: () => {},
    depthFunc: () => {},
    depthMask: () => {},
    stencilFunc: () => {},
    stencilMask: () => {},
    stencilOp: () => {},
    blendFuncSeparate: () => {},
    blendFunc: () => {},
    blendEquationSeparate: () => {},
    colorMask: () => {},
    activeTexture: () => {},
    useProgram: () => {},
    bindFramebuffer: () => {},
    bindBuffer: () => {},
  } as Record<string, unknown>
  for (const [index, name] of constants.entries()) gl[name] = index + 1
  gl.NO_ERROR = 0
  return { gl, errors: () => errors, viewportCalls: () => viewportCalls }
}

test('reuses and resets the projection matrix between frames', () => {
  const view = new ViewTransform()
  view.initialize({ x: 0, y: 0, width: 100, height: 50 })
  const renderer = new ModelRenderer(view)
  const matrices: CubismMatrix44[] = []
  const snapshots: number[][] = []
  const model = modelHarness(matrix => {
    matrices.push(matrix)
    snapshots.push([...matrix.getArray()])
    // Cubism composes its model transform into the provided projection.
    matrix.translateRelative(3, 4)
  })
  const time = { update: () => {}, deltaTime: 1 / 60 } as unknown as TimeManager

  renderer.render(model, { x: 0, y: 0, width: 100, height: 50 }, time)
  renderer.render(model, { x: 0, y: 0, width: 100, height: 50 }, time)

  assert.equal(matrices.length, 2)
  assert.equal(matrices[0], matrices[1])
  assert.deepEqual(snapshots[0], snapshots[1])
})

test('restores GL state when model drawing throws', () => {
  const view = new ViewTransform()
  view.initialize({ x: 0, y: 0, width: 100, height: 100 })
  const renderer = new ModelRenderer(view)
  const harness = glHarness()
  renderer.setGl(harness.gl as unknown as WebGLRenderingContext)
  const model = modelHarness(() => { throw new Error('draw failed') })

  const time = { update: () => {}, deltaTime: 0 } as unknown as TimeManager
  assert.throws(() => renderer.render(model, { x: 0, y: 0, width: 100, height: 100 }, time), /draw failed/)
  assert.ok(harness.viewportCalls() >= 2)
})

test('samples WebGL errors only when diagnostics are explicitly enabled', () => {
  const previous = Config.WebGLDiagnosticsEnable
  const view = new ViewTransform()
  view.initialize({ x: 0, y: 0, width: 100, height: 100 })
  const renderer = new ModelRenderer(view)
  const harness = glHarness()
  renderer.setGl(harness.gl as unknown as WebGLRenderingContext)
  const model = modelHarness()

  try {
    const time = { update: () => {}, deltaTime: 0 } as unknown as TimeManager
    Config.WebGLDiagnosticsEnable = false
    renderer.render(model, { x: 0, y: 0, width: 100, height: 100 }, time)
    assert.equal(harness.errors(), 0)
    Config.WebGLDiagnosticsEnable = true
    renderer.render(model, { x: 0, y: 0, width: 100, height: 100 }, time)
    assert.equal(harness.errors(), 1)
  } finally {
    Config.WebGLDiagnosticsEnable = previous
  }
})
