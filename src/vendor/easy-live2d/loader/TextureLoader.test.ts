import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Project tests use the Node test runner through tsx.
import test from 'node:test'

import type { WebGLBackend } from '../rendering/WebGLBackend'

import { TextureLoader } from './TextureLoader'

class TestImage {
  static instances: TestImage[] = []
  width = 4096
  height = 2048
  crossOrigin = ''
  src = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor() { TestImage.instances.push(this) }

  removeAttribute(name: string) {
    if (name === 'src') this.src = ''
  }
}

function fixture(uploadError = false) {
  const deleted: unknown[] = []
  let uploads = 0
  let mipmaps = 0
  const gl = {
    createTexture: () => ({}),
    deleteTexture: (texture: unknown) => { deleted.push(texture) },
    bindTexture: () => {},
    texParameteri: () => {},
    pixelStorei: () => {},
    texImage2D: () => {
      uploads += 1
      if (uploadError) throw new Error('Upload failed')
    },
    generateMipmap: () => { mipmaps += 1 },
  }
  const loader = new TextureLoader({ getGl: () => gl } as unknown as WebGLBackend)
  const originalImage = globalThis.Image
  TestImage.instances = []
  globalThis.Image = TestImage as unknown as typeof Image
  return {
    loader,
    deleted,
    uploads: () => uploads,
    mipmaps: () => mipmaps,
    restore: () => { globalThis.Image = originalImage },
  }
}

test('upload preserves original dimensions and mipmaps without retaining its decoded image', () => {
  const f = fixture()
  try {
    let texture: unknown
    f.loader.createTextureFromPngFile('texture.png', true, (info) => {
      assert.equal(info.width, 4096)
      assert.equal(info.height, 2048)
      assert.equal(info.img, null)
      texture = info.id
    })
    const image = TestImage.instances[0]!
    image.onload!()
    assert.equal(image.src, '')
    assert.equal(image.onload, null)
    assert.equal(image.onerror, null)
    f.loader.createTextureFromPngFile('texture.png', true, info => assert.equal(info.id, texture))
    assert.equal(TestImage.instances.length, 1)
    assert.equal(f.uploads(), 1)
    assert.equal(f.mipmaps(), 1)
    f.loader.release()
    f.loader.release()
    assert.deepEqual(f.deleted, [texture])
  } finally {
    f.restore()
  }
})

test('release cancels pending images and ignores a load event already queued by the browser', () => {
  const f = fixture()
  try {
    const errors: Error[] = []
    let callbacks = 0
    f.loader.createTextureFromPngFile('texture.png', true, () => { callbacks += 1 }, error => errors.push(error))
    const image = TestImage.instances[0]!
    const queuedLoad = image.onload!
    f.loader.release()
    queuedLoad()
    f.loader.release()
    assert.equal(callbacks, 0)
    assert.equal(f.uploads(), 0)
    assert.equal(errors.length, 1)
    assert.equal(errors[0]!.name, 'AbortError')
    assert.equal(image.src, '')
    assert.equal(image.onload, null)
    assert.equal(image.onerror, null)
  } finally {
    f.restore()
  }
})

test('an upload failure deletes its partially allocated texture and settles the request', () => {
  const f = fixture(true)
  try {
    const errors: Error[] = []
    f.loader.createTextureFromPngFile('texture.png', true, () => assert.fail('Unexpected upload success'), error => errors.push(error))
    TestImage.instances[0]!.onload!()
    assert.equal(errors[0]!.message, 'Upload failed')
    assert.equal(f.deleted.length, 1)
    f.loader.release()
    assert.equal(errors.length, 1)
    assert.equal(f.deleted.length, 1)
  } finally {
    f.restore()
  }
})
