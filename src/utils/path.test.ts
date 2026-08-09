import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { joinWithSeparator } from './path'

test('joins Windows paths without escaping Unicode or shell metacharacters', () => {
  assert.equal(
    joinWithSeparator('\\', 'C:\\用户 目录\\猫咪#100%', '模型😀', '纹理.png'),
    'C:\\用户 目录\\猫咪#100%\\模型😀\\纹理.png',
  )
})

test('preserves Windows drive roots and normalizes mixed separators', () => {
  assert.equal(joinWithSeparator('\\', 'C:\\'), 'C:\\')
  assert.equal(joinWithSeparator('\\', 'C:/', '\\模型//资源\\', '/背景.png'), 'C:\\模型\\资源\\背景.png')
})

test('preserves UNC roots while collapsing duplicate separators', () => {
  assert.equal(
    joinWithSeparator('\\', '\\\\server\\共享//模型\\', '\\resources//声音.wav'),
    '\\\\server\\共享\\模型\\resources\\声音.wav',
  )
})

test('normalizes POSIX separators without treating backslashes as separators', () => {
  assert.equal(joinWithSeparator('/', '/tmp//猫 #100%', '模型😀', 'a\\b.png'), '/tmp/猫 #100%/模型😀/a\\b.png')
})
