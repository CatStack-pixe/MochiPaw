<script setup lang="ts">
import { getTauriVersion } from '@tauri-apps/api/app'
import { emit } from '@tauri-apps/api/event'
import { appLogDir } from '@tauri-apps/api/path'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { openPath } from '@tauri-apps/plugin-opener'
import { arch, platform, version } from '@tauri-apps/plugin-os'
import { Button, Descriptions, message } from 'antdv-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { ProcessMetrics } from '@/plugins/adminStatus'
import type { ModelResourceMetric, ResourceMetricCategory } from '@/utils/modelResourceMetrics'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { LISTEN_KEY } from '@/constants'
import { compactProcessMemory, getProcessMetrics } from '@/plugins/adminStatus'
import { useAppStore } from '@/stores/app'
import { useModelStore } from '@/stores/model'
import { getModelResourceMetrics } from '@/utils/modelResourceMetrics'

const appStore = useAppStore()
const modelStore = useModelStore()
const logDir = ref('')
const metrics = ref<ProcessMetrics>()
const metricsError = ref('')
const metricsLoading = ref(false)
const resourceMetrics = ref<ModelResourceMetric[]>([])
const resourceMetricsError = ref('')
const resourceMetricsLoading = ref(false)
const compactingMemory = ref(false)
const { t } = useI18n()
let metricsTimer: ReturnType<typeof window.setInterval> | undefined
const authors = [
  {
    name: 'InfinityXCat',
    avatar: '/authors/infinityxcat.jpg',
  },
  {
    name: 'Dev.Cloud.ZTR_OS',
    avatar: '/authors/dev-cloud-ztros.jpg',
  },
]

onMounted(async () => {
  logDir.value = await appLogDir()
  await refreshMetrics()
  await refreshResourceMetrics()
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

async function refreshResourceMetrics() {
  resourceMetricsLoading.value = true

  try {
    resourceMetrics.value = await getModelResourceMetrics(modelStore.models)
    resourceMetricsError.value = ''
  } catch (error) {
    resourceMetricsError.value = error instanceof Error ? error.message : String(error)
  } finally {
    resourceMetricsLoading.value = false
  }
}

async function handleCompactMemory() {
  compactingMemory.value = true

  try {
    await compactProcessMemory()
    await refreshMetrics()
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

const currentModelResourceMetric = computed(() => {
  return resourceMetrics.value.find(item => item.modelId === modelStore.currentModel?.id)
})

function getCategoryLabel(category: ResourceMetricCategory) {
  return t(`pages.preference.about.resourceCategories.${category}`)
}

const modelResourceItems = computed(() => {
  return resourceMetrics.value.map((item) => {
    return {
      label: `${item.modelId} (${item.mode})`,
      value: t('pages.preference.about.metrics.resourceUsageValue', {
        memory: formatBytes(item.estimatedMemoryBytes),
        fileSize: formatBytes(item.fileBytes),
        files: item.fileCount,
      }),
    }
  })
})

const currentModelResourceItems = computed(() => {
  return currentModelResourceMetric.value?.categories.map((item) => {
    return {
      label: getCategoryLabel(item.category),
      value: t('pages.preference.about.metrics.resourceUsageValue', {
        memory: formatBytes(item.estimatedMemoryBytes),
        fileSize: formatBytes(item.fileBytes),
        files: item.fileCount,
      }),
    }
  }) ?? []
})
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
          <span>{{ author.name }}</span>
        </div>
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
        @click="refreshMetrics"
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

    <ProListItem
      :description="resourceMetricsError || $t('pages.preference.about.hints.resourceMetrics')"
      :title="$t('pages.preference.about.labels.resourceMetrics')"
      vertical
    >
      <Descriptions
        bordered
        class="w-full"
        :column="1"
        size="small"
      >
        <Descriptions.Item
          v-for="item in modelResourceItems"
          :key="item.label"
          :label="item.label"
        >
          {{ item.value }}
        </Descriptions.Item>
      </Descriptions>

      <Descriptions
        v-if="currentModelResourceItems.length"
        bordered
        class="w-full"
        :column="2"
        size="small"
      >
        <template #title>
          {{ $t('pages.preference.about.labels.currentModelResources') }}
        </template>

        <Descriptions.Item
          v-for="item in currentModelResourceItems"
          :key="item.label"
          :label="item.label"
        >
          {{ item.value }}
        </Descriptions.Item>
      </Descriptions>

      <Button
        :loading="resourceMetricsLoading"
        @click="refreshResourceMetrics"
      >
        {{ $t('pages.preference.about.buttons.refreshResources') }}
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

.author-avatar {
  width: 32px;
  height: 32px;
  border-radius: 999px;
  object-fit: cover;
}
</style>
