import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Project tests use the Node test runner through tsx.
import test from 'node:test'

import {
  getCubismMocVersion,
  getCubismRuntimeDiagnostics,
  Live2DLoadError,
} from './runtimeDiagnostics'

type CoreStub = {
  Version: {
    csmGetVersion: () => number
    csmGetLatestMocVersion: () => number
    csmGetMocVersion: (buffer: ArrayBuffer) => number
  }
}

const runtimeGlobal = globalThis as unknown as {
  Live2DCubismCore?: CoreStub
}

test('reports 5.3 Core and MOC diagnostics', () => {
  const originalCore = runtimeGlobal.Live2DCubismCore
  runtimeGlobal.Live2DCubismCore = {
    Version: {
      csmGetVersion: () => 50300,
      csmGetLatestMocVersion: () => 6,
      csmGetMocVersion: buffer => buffer.byteLength ? 6 : 0,
    },
  }

  try {
    assert.deepEqual(getCubismRuntimeDiagnostics(), {
      coreVersion: 50300,
      latestMocVersion: 6,
    })
    assert.equal(getCubismMocVersion(new Uint8Array([1]).buffer), 6)
  } finally {
    runtimeGlobal.Live2DCubismCore = originalCore
  }
})

test('returns a readable error when the Core is unavailable', () => {
  const originalCore = runtimeGlobal.Live2DCubismCore
  runtimeGlobal.Live2DCubismCore = undefined

  try {
    assert.throws(
      () => getCubismMocVersion(new ArrayBuffer(1)),
      (error: unknown) => error instanceof Live2DLoadError
        && error.code === 'core-unavailable',
    )
  } finally {
    runtimeGlobal.Live2DCubismCore = originalCore
  }
})
