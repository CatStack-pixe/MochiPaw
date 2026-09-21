// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Application } from 'pixi.js'

import { CubismSetting, Live2DSprite } from '../src/vendor/easy-live2d'
import { CubismFramework } from '../src/vendor/easy-live2d/Framework/live2dcubismframework'
import { CubismShaderManager_WebGL } from '../src/vendor/easy-live2d/Framework/rendering/cubismshader_webgl'

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

async function waitReady(sprite: Live2DSprite) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      sprite.ready,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Renderer readiness timed out')), 20_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function smoke() {
  ensure(typeof globalThis.Live2DCubismCore === 'undefined', 'Core was eagerly loaded')
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  const app = new Application()
  await app.init({ canvas, width: 400, height: 240, resolution: 1, backgroundAlpha: 0, autoStart: false, preserveDrawingBuffer: true })
  const base = '/src-tauri/assets/models/standard/'
  const modelJSON = await fetch(`${base}cat.model3.json`).then(response => response.json())
  const modelSetting = new CubismSetting({ modelJSON })
  modelSetting.redirectPath(({ file }) => `${base}${file}`)
  const results: Array<{ cycle: number, textures: number, visiblePixels: number }> = []
  let renderedFrame = ''

  for (let cycle = 0; cycle < 10; cycle += 1) {
    const sprite = new Live2DSprite({ modelSetting, ticker: app.ticker })
    app.stage.addChild(sprite)
    // No ticker: exercise loading while a desktop window is hidden.
    app.render()
    await waitReady(sprite)
    ensure(CubismFramework.isInitialized(), 'Core did not initialize')
    const size = sprite.getModelCanvasSize()!
    sprite.anchor.set(0.5)
    sprite.scale.set(Math.min(400 / size.width, 240 / size.height))
    sprite.position.set(200, 120)
    // Core/model readiness precedes the SDK's asynchronous shader fetches.
    // Render bounded additional frames, checking pixels after each synchronous
    // draw instead of treating resource readiness as proof of visible output.
    const gl = canvas.getContext('webgl2')!
    ensure(gl, 'A WebGL2 context is required')
    const pixels = new Uint8Array(canvas.width * canvas.height * 4)
    let visiblePixels = 0
    const deadline = performance.now() + 20_000
    while (visiblePixels <= 100 && performance.now() < deadline) {
      app.render()
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      visiblePixels = 0
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] > 0) visiblePixels += 1
      }
      if (visiblePixels <= 100) await new Promise(resolve => setTimeout(resolve, 25))
    }
    ensure(visiblePixels > 100, `Blank rendered model at cycle ${cycle}`)
    if (cycle === 9) renderedFrame = canvas.toDataURL('image/png')

    // Verify actual uploaded GL textures, not only JavaScript references.
    const textures = (sprite as any)._textureLoader._textures.map((texture: any) => texture.id) as WebGLTexture[]
    ensure(textures.length === 3, 'Expected the three bundled model textures')
    ensure(textures.every(texture => gl.isTexture(texture)), 'Missing live GPU texture')
    const modelRenderer = (sprite as any)._model.getRenderer()
    const buffers = Object.values(modelRenderer._bufferData).filter(Boolean) as WebGLBuffer[]
    ensure(buffers.length > 0 && buffers.every(buffer => gl.isBuffer(buffer)), 'Missing model GPU buffers')
    const shader = CubismShaderManager_WebGL.getInstance().getShader(gl) as any
    const programs = [...new Set(shader._shaderSets.map((entry: any) => entry.shaderProgram))] as WebGLProgram[]
    ensure(programs.length > 0 && programs.every(program => gl.isProgram(program)), 'Missing model shader programs')
    app.stage.removeChild(sprite)
    sprite.destroy()
    // GL defers destruction of a current program until it is no longer bound.
    gl.useProgram(null)
    ensure(textures.every(texture => !gl.isTexture(texture)), 'Model textures leaked after destroy')
    ensure(buffers.every(buffer => !gl.isBuffer(buffer)), 'Model buffers leaked after destroy')
    ensure(programs.every(program => !gl.isProgram(program)), 'Model shaders leaked after final runtime release')
    ensure(!CubismFramework.isInitialized(), 'Cubism runtime references leaked')
    ensure(app.stage.children.length === 0, 'Model remained on the stage')
    results.push({ cycle, textures: textures.length, visiblePixels })
  }

  // Cancelling before a model's first frame must still settle its ready promise.
  const cancelled = new Live2DSprite({ modelSetting, ticker: app.ticker })
  const rejection = cancelled.ready.then(() => false, error => error.name === 'AbortError')
  cancelled.destroy()
  ensure(await rejection, 'Cancelled model readiness did not settle')
  app.destroy(true)
  return { results, renderedFrame }
}

Object.assign(window, { rendererSmoke: smoke })
