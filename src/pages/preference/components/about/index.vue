<!-- SPDX-FileCopyrightText: 2025 ayangweb
  SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0
 -->

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
import { LISTEN_KEY } from '@/constants'
import { compactProcessMemory, getProcessMetrics } from '@/plugins/adminStatus'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()
const logDir = ref('')
const metrics = ref<ProcessMetrics>()
const metricsError = ref('')
const metricsLoading = ref(false)
const compactingMemory = ref(false)
const { t } = useI18n()
let metricsTimer: ReturnType<typeof window.setInterval> | undefined
let metricsRefreshing = false
const METRICS_REFRESH_INTERVAL = 2000
const authors = [
  {
    name: 'InfinityXCat',
    avatar: '/authors/infinityxcat.jpg',
    role: 'Project maintainer',
  },
  {
    name: 'Dev.Cloud.ZTR_OS',
    avatar: '/authors/dev-cloud-ztros.jpg',
    role: 'Contributor',
  },
]
const qqGroup = '966043945'
const originalProjectUrl = 'https://github.com/ayangweb/BongoCat'
const modStatement = [
  'MochiPaw is a maintained derivative of BongoCat with additional features, compatibility work, and packaging updates.',
  'The original project link is kept here for attribution and history.',
  'MochiPaw is maintained as a separate downstream version.',
]

onMounted(async () => {
  logDir.value = await appLogDir()
  await refreshMetrics({ showLoading: true })
  scheduleMetricsRefresh()
})

onBeforeUnmount(() => {
  if (metricsTimer) {
    window.clearTimeout(metricsTimer)
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

async function copyText(value: string, successText: string) {
  await writeText(value)
  message.success(successText)
}

function scheduleMetricsRefresh() {
  metricsTimer = window.setTimeout(async () => {
    await refreshMetrics()
    scheduleMetricsRefresh()
  }, METRICS_REFRESH_INTERVAL)
}

async function refreshMetrics(options: { showLoading?: boolean } = {}) {
  if (metricsRefreshing) return

  if (document.hidden) return

  metricsRefreshing = true

  if (options.showLoading) {
    metricsLoading.value = true
  }

  try {
    metrics.value = await getProcessMetrics()
    metricsError.value = ''
  } catch (error) {
    metricsError.value = error instanceof Error ? error.message : String(error)
  } finally {
    metricsRefreshing = false

    if (options.showLoading) {
      metricsLoading.value = false
    }
  }
}

function handleRefreshMetrics() {
  return refreshMetrics({ showLoading: true })
}

async function handleCompactMemory() {
  compactingMemory.value = true

  try {
    await compactProcessMemory()
    await refreshMetrics({ showLoading: true })
    message.success(t('pages.preference.about.hints.compactMemorySuccess'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    compactingMemory.value = false
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

    <ProListItem
      :description="$t('pages.preference.about.hints.authorInfo')"
      :title="$t('pages.preference.about.labels.authorInfo')"
      vertical
    >
      <div class="author-list">
        <div
          v-for="author in authors"
          :key="author.name"
          class="author-item"
        >
          <img
            :alt="author.name"
            class="author-avatar"
            :src="author.avatar"
          >
          <div class="author-meta">
            <span>{{ author.name }}</span>
            <small v-if="author.role">{{ author.role }}</small>
          </div>
        </div>
      </div>
    </ProListItem>

    <ProListItem
      description="QQ group: 966043945"
      title="Community"
    >
      <Button @click="copyText(qqGroup, 'QQ group ID copied')">
        Copy group ID
      </Button>
    </ProListItem>

    <ProListItem
      :description="originalProjectUrl"
      title="Original project"
    >
      <Button @click="openUrl(originalProjectUrl)">
        Open link
      </Button>
    </ProListItem>

    <ProListItem
      title="Version note"
      vertical
    >
      <div class="about-notes">
        <p
          v-for="line in modStatement"
          :key="line"
          class="about-note"
        >
          {{ line }}
        </p>
      </div>
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
        @click="handleRefreshMetrics"
      >
        {{ $t('pages.preference.about.buttons.refresh') }}
      </Button>

      <Button
        :loading="compactingMemory"
        type="primary"
        @click="handleCompactMemory"
      >
        {{ $t('pages.preference.about.buttons.compactMemory') }}
      </Button>
    </ProListItem>
  </ProList>
</template>

<style scoped>
.author-list {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.author-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}

.author-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.author-meta small {
  color: var(--ant-color-text-description);
  font-size: 12px;
  font-weight: 400;
}

.author-avatar {
  width: 32px;
  height: 32px;
  border-radius: 999px;
  object-fit: cover;
}

.about-notes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.about-note {
  margin: 0;
  line-height: 1.6;
}
</style>
