import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import {
  formatPersistenceRecoveryReport,
  normalizePersistenceRecoveryReport,
  PERSISTENCE_STORE_IDS,
} from './persistenceRecovery'

test('includes Pomodoro in the persistence recovery allowlist', () => {
  assert.ok(PERSISTENCE_STORE_IDS.includes('pomodoro'))
})

test('normalizes recovered stores and backup failures from the backend payload', () => {
  const report = normalizePersistenceRecoveryReport({
    recovered: [{
      storeId: 'model',
      backupPath: 'C:\\用户 数据\\pinia\\model.corrupt-1.json',
      reason: 'expected value at line 1 column 1',
    }],
    failures: [{
      storeId: 'general',
      path: 'C:\\用户 数据\\pinia\\general.json',
      reason: 'access denied',
    }],
  })

  assert.deepEqual(report, {
    recovered: [{
      storeId: 'model',
      backupPath: 'C:\\用户 数据\\pinia\\model.corrupt-1.json',
      reason: 'expected value at line 1 column 1',
    }],
    failures: [{
      storeId: 'general',
      path: 'C:\\用户 数据\\pinia\\general.json',
      reason: 'access denied',
    }],
  })
})

test('ignores malformed entries and empty reports', () => {
  assert.equal(normalizePersistenceRecoveryReport(null), null)
  assert.equal(normalizePersistenceRecoveryReport({ recovered: [], failures: [] }), null)
  assert.equal(normalizePersistenceRecoveryReport({
    recovered: [{ storeId: 'model', backupPath: '', reason: 'invalid' }],
    failures: [{ storeId: 'cat', path: 'C:\\cat.json' }],
  }), null)
})

test('formats localized known stores and safely falls back to an unknown store ID', () => {
  const viewModel = formatPersistenceRecoveryReport({
    recovered: [{ storeId: 'model', backupPath: 'model.backup', reason: 'invalid JSON' }],
    failures: [{ storeId: 'futureStore', path: 'future.json', reason: 'locked' }],
  }, {
    model: 'Model settings',
  })

  assert.deepEqual(viewModel, {
    recovered: [{
      storeId: 'model',
      storeName: 'Model settings',
      path: 'model.backup',
      reason: 'invalid JSON',
    }],
    failures: [{
      storeId: 'futureStore',
      storeName: 'futureStore',
      path: 'future.json',
      reason: 'locked',
    }],
  })
})
