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
const contributors = ref<GitHubContributor[]>([])
const contributorsLoading = ref(false)
const contributorsError = ref('')
const { t } = useI18n()
let metricsTimer: ReturnType<typeof window.setInterval> | undefined
let metricsRefreshing = false
const METRICS_REFRESH_INTERVAL = 2000
const GITHUB_REPOSITORY_URL = 'https://github.com/CatStack-pixe/MochiPaw'
const CONTRIBUTORS_MANIFEST_URL = '/contributors.json'
const GITHUB_LICENSE_URL = `${GITHUB_REPOSITORY_URL}/blob/master/LICENSE`

interface GitHubContributor {
  login: string
  avatarUrl: string
  profileUrl: string
}

onMounted(async () => {
  logDir.value = await appLogDir()
  void loadContributors()
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

async function loadContributors() {
  contributorsLoading.value = true
  contributorsError.value = ''

  try {
    const response = await fetch(CONTRIBUTORS_MANIFEST_URL)

    if (!response.ok) throw new Error(`Contributors manifest request failed: ${response.status}`)

    const payload: unknown = await response.json()

    if (!Array.isArray(payload)) throw new Error('Contributors manifest response is not a list')

    contributors.value = payload.flatMap((value) => {
      if (!isContributor(value)) return []

      return [{
        login: value.login,
        avatarUrl: value.avatarUrl,
        profileUrl: value.profileUrl,
      }]
    })
  } catch {
    contributorsError.value = t('pages.preference.about.hints.contributorsUnavailable')
  } finally {
    contributorsLoading.value = false
  }
}

function isContributor(value: unknown): value is GitHubContributor {
  if (!value || typeof value !== 'object') return false

  const contributor = value as Record<string, unknown>

  return typeof contributor.login === 'string'
    && typeof contributor.avatarUrl === 'string'
    && typeof contributor.profileUrl === 'string'
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
      :description="$t('pages.preference.about.hints.contributors')"
      :title="$t('pages.preference.about.labels.contributors')"
      vertical
    >
      <div
        v-if="contributorsLoading"
        class="contributors-status"
      >
        {{ $t('pages.preference.about.hints.contributorsLoading') }}
      </div>

      <div
        v-else-if="contributorsError"
        class="contributors-status"
      >
        <span>{{ contributorsError }}</span>
        <Button @click="loadContributors">
          {{ $t('pages.preference.about.buttons.retry') }}
        </Button>
      </div>

      <div
        v-else
        class="contributor-list"
      >
        <button
          v-for="contributor in contributors"
          :key="contributor.login"
          class="contributor-item"
          :title="contributor.login"
          type="button"
          @click="openUrl(contributor.profileUrl)"
        >
          <img
            :alt="contributor.login"
            class="contributor-avatar"
            :src="contributor.avatarUrl"
          >
          <span>{{ contributor.login }}</span>
        </button>
      </div>
    </ProListItem>

    <ProListItem
      :description="GITHUB_REPOSITORY_URL"
      :title="$t('pages.preference.about.labels.repository')"
    >
      <Button @click="openUrl(GITHUB_REPOSITORY_URL)">
        {{ $t('pages.preference.about.buttons.openRepository') }}
      </Button>
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.about.hints.license')"
      :title="$t('pages.preference.about.labels.license')"
      vertical
    >
      <Button @click="openUrl(GITHUB_LICENSE_URL)">
        {{ $t('pages.preference.about.buttons.viewLicense') }}
      </Button>
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
.contributor-list {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.contributor-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-weight: 500;
}

.contributor-item:hover,
.contributor-item:focus-visible {
  color: var(--ant-color-primary);
}

.contributors-status {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ant-color-text-description);
}

.contributor-avatar {
  width: 32px;
  height: 32px;
  border-radius: 999px;
  object-fit: cover;
}
</style>
