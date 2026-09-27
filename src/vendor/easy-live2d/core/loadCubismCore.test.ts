import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Project tests use the Node test runner through tsx.
import test from 'node:test'

import { CubismColorBlend } from '../Framework/model/cubismmodel'
import { loadCubismCore } from './loadCubismCore'

class TestScript {
  async = false
  src = ''
  removed = false
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  remove() { this.removed = true }
}

function fixture() {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const coreDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Live2DCubismCore')
  const scripts: TestScript[] = []
  Reflect.deleteProperty(globalThis, 'Live2DCubismCore')
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => new TestScript(),
      head: { appendChild: (script: TestScript) => { scripts.push(script) } },
    },
  })
  return {
    scripts,
    installCore: (values: Record<string, unknown> = {}) => {
      Object.defineProperty(globalThis, 'Live2DCubismCore', {
        configurable: true,
        value: { Version: { csmGetVersion: () => 50300 }, ...values },
      })
    },
    restore: () => {
      for (const [key, descriptor] of [
        ['document', documentDescriptor],
        ['Live2DCubismCore', coreDescriptor],
      ] as const) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test('concurrent sprites share a single Core load and loaded Core needs no additional script', async () => {
  const f = fixture()
  try {
    const first = loadCubismCore()
    const second = loadCubismCore()
    assert.equal(first, second)
    assert.equal(f.scripts.length, 1)
    assert.equal(f.scripts[0]!.src, '/js/live2dcubismcore.min.js')
    f.installCore()
    f.scripts[0]!.onload!()
    await first
    await second
    await loadCubismCore()
    assert.equal(f.scripts.length, 1)
    assert.equal(f.scripts[0]!.removed, true)
    assert.equal(f.scripts[0]!.onload, null)
  } finally {
    f.restore()
  }
})

test('failed Core script loading releases the shared promise so another sprite can retry', async () => {
  const f = fixture()
  try {
    const failed = loadCubismCore()
    f.scripts[0]!.onerror!()
    await assert.rejects(failed, /Failed to load Live2D Cubism Core/)
    assert.equal(f.scripts[0]!.removed, true)
    const retried = loadCubismCore()
    assert.equal(f.scripts.length, 2)
    f.installCore()
    f.scripts[1]!.onload!()
    await retried
  } finally {
    f.restore()
  }
})

test('script load waits for Core runtime initialization before allowing model creation', async () => {
  const f = fixture()
  try {
    let resolved = false
    const pending = loadCubismCore().then(() => { resolved = true })
    f.scripts[0]!.onload!()
    await Promise.resolve()
    assert.equal(resolved, false)
    f.installCore()
    await pending
    assert.equal(resolved, true)
  } finally {
    f.restore()
  }
})

test('Framework imports and blend name enumeration work without eagerly reading Core', () => {
  const f = fixture()
  try {
    const names = Object.keys(CubismColorBlend)
    assert.equal(names.length, 19)
    assert.equal(CubismColorBlend.ColorBlend_None, -1)
    const constants = Object.fromEntries(names
      .filter(name => name !== 'ColorBlend_None')
      .map((name, index) => [name.replace('ColorBlend_', 'ColorBlendType_'), index + 10]))
    f.installCore(constants)
    for (const name of names) {
      const value = CubismColorBlend[name as keyof typeof CubismColorBlend]
      assert.equal(value, name === 'ColorBlend_None' ? -1 : constants[name.replace('ColorBlend_', 'ColorBlendType_')])
    }
  } finally {
    f.restore()
  }
})
