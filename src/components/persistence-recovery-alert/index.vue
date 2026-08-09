<!-- SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Alert, Button, Flex, Modal } from 'antdv-next'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { PersistenceRecoveryReport, PersistenceStoreId } from '@/utils/persistenceRecovery'

import { WINDOW_LABEL } from '@/constants'
import { logError, logInfo } from '@/utils/diagnostics'
import {
  formatPersistenceRecoveryReport,
  normalizePersistenceRecoveryReport,
} from '@/utils/persistenceRecovery'

const { t } = useI18n()
const open = ref(false)
const report = ref<PersistenceRecoveryReport | null>(null)

const storeNames = computed<Partial<Record<PersistenceStoreId, string>>>(() => ({
  app: t('components.persistenceRecovery.stores.app'),
  cat: t('components.persistenceRecovery.stores.cat'),
  general: t('components.persistenceRecovery.stores.general'),
  model: t('components.persistenceRecovery.stores.model'),
  shortcut: t('components.persistenceRecovery.stores.shortcut'),
  typingStats: t('components.persistenceRecovery.stores.typingStats'),
}))

const viewModel = computed(() => report.value
  ? formatPersistenceRecoveryReport(report.value, storeNames.value)
  : null)
const hasRecovered = computed(() => Boolean(viewModel.value?.recovered.length))
const hasFailures = computed(() => Boolean(viewModel.value?.failures.length))
const alertType = computed(() => {
  if (!hasFailures.value) return 'success'
  return hasRecovered.value ? 'warning' : 'error'
})
const summary = computed(() => {
  if (!hasFailures.value) return t('components.persistenceRecovery.successSummary')
  if (hasRecovered.value) return t('components.persistenceRecovery.mixedSummary')
  return t('components.persistenceRecovery.failureSummary')
})

onMounted(async () => {
  if (getCurrentWebviewWindow().label !== WINDOW_LABEL.PREFERENCE) return

  try {
    const result = normalizePersistenceRecoveryReport(
      await invoke<unknown>('take_persistence_recovery_report'),
    )

    if (!result) return

    report.value = result
    open.value = true
    logInfo('[persistence-recovery] showing recovery report', {
      recoveredStoreIds: result.recovered.map(item => item.storeId),
      failedStoreIds: result.failures.map(item => item.storeId),
    })
  } catch (error) {
    logError('[persistence-recovery] failed to take recovery report', { error })
  }
})
</script>

<template>
  <Modal
    v-if="viewModel"
    v-model:open="open"
    centered
    :closable="false"
    :keyboard="false"
    :mask-closable="false"
    :title="hasFailures ? t('components.persistenceRecovery.failureTitle') : t('components.persistenceRecovery.title')"
    :width="680"
  >
    <Flex
      gap="middle"
      vertical
    >
      <Alert
        :message="summary"
        show-icon
        :type="alertType"
      />

      <p class="m-0 color-text-secondary text-sm">
        {{ t('components.persistenceRecovery.consequence') }}
      </p>

      <section v-if="viewModel.recovered.length">
        <h3 class="mb-1 font-semibold">
          {{ t('components.persistenceRecovery.recoveredTitle') }}
        </h3>

        <div
          v-for="item in viewModel.recovered"
          :key="`recovered-${item.storeId}-${item.path}`"
          class="border-t border-[--ant-color-border-secondary] py-3 first:border-t-0"
        >
          <strong>{{ item.storeName }}</strong>
          <div class="mt-1 color-text-secondary">
            {{ t('components.persistenceRecovery.backupLocation') }}
          </div>
          <code class="block whitespace-pre-wrap break-all">{{ item.path }}</code>
          <div class="mt-1 break-words color-text-tertiary text-sm">
            {{ t('components.persistenceRecovery.technicalReason') }}: {{ item.reason }}
          </div>
        </div>
      </section>

      <section v-if="viewModel.failures.length">
        <h3 class="mb-1 font-semibold color-error">
          {{ t('components.persistenceRecovery.failedTitle') }}
        </h3>

        <div
          v-for="item in viewModel.failures"
          :key="`failed-${item.storeId}-${item.path}`"
          class="border-t border-[--ant-color-border-secondary] py-3 first:border-t-0"
        >
          <strong>{{ item.storeName }}</strong>
          <div class="mt-1 color-text-secondary">
            {{ t('components.persistenceRecovery.fileLocation') }}
          </div>
          <code class="block whitespace-pre-wrap break-all">{{ item.path }}</code>
          <div class="mt-1 break-words color-text-tertiary text-sm">
            {{ t('components.persistenceRecovery.technicalReason') }}: {{ item.reason }}
          </div>
        </div>
      </section>
    </Flex>

    <template #footer>
      <Button
        type="primary"
        @click="open = false"
      >
        {{ t('components.persistenceRecovery.acknowledge') }}
      </Button>
    </template>
  </Modal>
</template>
