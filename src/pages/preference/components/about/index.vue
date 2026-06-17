<script setup lang="ts">
import { getTauriVersion } from '@tauri-apps/api/app'
import { emit } from '@tauri-apps/api/event'
import { appLogDir } from '@tauri-apps/api/path'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { openPath, openUrl } from '@tauri-apps/plugin-opener'
import { arch, platform, version } from '@tauri-apps/plugin-os'
import { Button, Descriptions, message } from 'antdv-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { ProcessMetrics } from '@/plugins/adminStatus'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { GITHUB_LINK, LISTEN_KEY } from '@/constants'
import { getProcessMetrics } from '@/plugins/adminStatus'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()
const logDir = ref('')
const metrics = ref<ProcessMetrics>()
const metricsError = ref('')
const metricsLoading = ref(false)
const { t } = useI18n()
let metricsTimer: ReturnType<typeof window.setInterval> | undefined

onMounted(async () => {
  logDir.value = await appLogDir()
  await refreshMetrics()
  metricsTimer = window.setInterval(refreshMetrics, 1000)
})

onBeforeUnmount(() => {
  if (metricsTimer) {
    window.clearInterval(metricsTimer)
  }
})

function handleUpdate() {
  emit(LISTEN_KEY.UPDATE_APP)
}

async function copyInfo() {
  const info = {
    appName: appStore.name,
    appVersion: appStore.version,
    tauriVersion: await getTauriVersion(),
    platform: platform(),
    platformArch: arch(),
    platformVersion: version(),
  }

  await writeText(JSON.stringify(info, null, 2))

  message.success(t('pages.preference.about.hints.copySuccess'))
}

function feedbackIssue() {
  openUrl(`${GITHUB_LINK}/issues/new/choose`)
}

async function refreshMetrics() {
  metricsLoading.value = true

  try {
    metrics.value = await getProcessMetrics()
    metricsError.value = ''
  } catch (error) {
    metricsError.value = error instanceof Error ? error.message : String(error)
  } finally {
    metricsLoading.value = false
  }
}

function formatBytes(bytes?: number) {
  if (!bytes) return '--'

  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function formatCpuUsage(value?: number | null) {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : '--'
}

function formatUptime(seconds?: number) {
  if (seconds === undefined) return '--'

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const restSeconds = seconds % 60

  return [hours, minutes, restSeconds]
    .map(value => value.toString().padStart(2, '0'))
    .join(':')
}

const metricsItems = computed(() => [
  {
    label: t('pages.preference.about.metrics.pid'),
    value: metrics.value?.pid ?? '--',
  },
  {
    label: t('pages.preference.about.metrics.cpuUsage'),
    value: formatCpuUsage(metrics.value?.cpuUsage),
  },
  {
    label: t('pages.preference.about.metrics.memory'),
    value: formatBytes(metrics.value?.memoryBytes),
  },
  {
    label: t('pages.preference.about.metrics.virtualMemory'),
    value: formatBytes(metrics.value?.virtualMemoryBytes),
  },
  {
    label: t('pages.preference.about.metrics.threads'),
    value: metrics.value?.threadCount || '--',
  },
  {
    label: t('pages.preference.about.metrics.uptime'),
    value: formatUptime(metrics.value?.uptimeSeconds),
  },
])
</script>

<template>
  <ProList :title="$t('pages.preference.about.labels.aboutApp')">
    <ProListItem
      :description="`v${appStore.version}`"
      :title="appStore.name"
    >
      <Button
        type="primary"
        @click="handleUpdate"
      >
        {{ $t('pages.preference.about.buttons.checkUpdate') }}
      </Button>
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.about.hints.appInfo')"
      :title="$t('pages.preference.about.labels.appInfo')"
    >
      <Button @click="copyInfo">
        {{ $t('pages.preference.about.buttons.copy') }}
      </Button>
    </ProListItem>

    <ProListItem :title="$t('pages.preference.about.labels.openSource')">
      <Button
        danger
        @click="feedbackIssue"
      >
        {{ $t('pages.preference.about.buttons.feedbackIssues') }}
      </Button>

      <template #description>
        <a :href="GITHUB_LINK">
          {{ GITHUB_LINK }}
        </a>
      </template>
    </ProListItem>

    <ProListItem
      :description="logDir"
      :title="$t('pages.preference.about.labels.appLog')"
    >
      <Button @click="openPath(logDir)">
        {{ $t('pages.preference.about.buttons.viewLog') }}
      </Button>
    </ProListItem>
  </ProList>

  <ProList :title="$t('pages.preference.about.labels.debugMonitor')">
    <ProListItem
      :description="metricsError || $t('pages.preference.about.hints.debugMonitor')"
      :title="$t('pages.preference.about.labels.processMetrics')"
      vertical
    >
      <Descriptions
        bordered
        class="w-full"
        :column="2"
        size="small"
      >
        <Descriptions.Item
          v-for="item in metricsItems"
          :key="item.label"
          :label="item.label"
        >
          {{ item.value }}
        </Descriptions.Item>
      </Descriptions>

      <Button
        :loading="metricsLoading"
        @click="refreshMetrics"
      >
        {{ $t('pages.preference.about.buttons.refresh') }}
      </Button>
    </ProListItem>
  </ProList>
</template>
