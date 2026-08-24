<!-- SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { platform } from '@tauri-apps/plugin-os'
import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'
import { useIntervalFn } from '@vueuse/core'
import { Flex, message, Modal } from 'antdv-next'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import { computed, markRaw, onUnmounted, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import VueMarkdown from 'vue-markdown-render'

import type { AvailableUpdate, UpdateCapability } from '@/utils/updateFlow'

import { useTauriListen } from '@/composables/useTauriListen'
import { GITHUB_LINK, INVOKE_KEY, LISTEN_KEY } from '@/constants'
import { showWindow } from '@/plugins/window'
import { useGeneralStore } from '@/stores/general'
import { logError, logInfo, logStep, logWarn } from '@/utils/diagnostics'
import { runAfterSavingPersistentStores } from '@/utils/persistence'
import {
  applyUpdate,
  disposeUpdate,
  fetchGitHubReleaseBody,
  getUpdateReleaseUrl,
  transferUpdateOwnership,
  UpdateCheckCoordinator,
  UpdateOperationGate,
} from '@/utils/updateFlow'

dayjs.extend(utc)

interface State {
  open: boolean
  update?: AvailableUpdate
  capability?: UpdateCapability
  updateBody: string
  updateDate: string
  downloading: boolean
  totalProgress?: number
  downloadProgress: number
}

const generalStore = useGeneralStore()
const state = reactive<State>({
  open: false,
  updateBody: '',
  updateDate: '',
  downloading: false,
  downloadProgress: 0,
})
const MESSAGE_KEY = 'updatable'
const { t } = useI18n()
const updateChecker = new UpdateCheckCoordinator({
  check: () => check({ timeout: 5000 }),
  getCapability: () => invoke<UpdateCapability>(INVOKE_KEY.GET_UPDATE_CAPABILITY),
})
const updateOperationGate = new UpdateOperationGate()

const { pause, resume } = useIntervalFn(checkUpdate, 1000 * 60 * 60 * 24)

watch(() => generalStore.update.autoCheck, (value) => {
  pause()

  if (!value) return

  void checkUpdate()

  resume()
}, { immediate: true })

useTauriListen<boolean>(LISTEN_KEY.UPDATE_APP, () => {
  if (state.downloading) return

  message.loading({
    key: MESSAGE_KEY,
    duration: 0,
    content: t('components.updateApp.hints.checkingUpdates'),
  })

  void checkUpdate(true)
})

const downloadProgress = computed(() => {
  const { downloadProgress, totalProgress } = state

  if (!totalProgress) return '0%'

  const progress = ((downloadProgress / totalProgress) * 100).toFixed(2)

  return `${progress}%`
})

const releaseUrl = computed(() => state.update
  ? getUpdateReleaseUrl(GITHUB_LINK, state.update.version)
  : `${GITHUB_LINK}/releases`)

const installManually = computed(() => state.capability?.installStrategy === 'manual')

async function checkUpdate(visibleMessage = false) {
  if (state.downloading) return

  const operationGeneration = updateOperationGate.capture()
  logStep('update', 'check started', { visibleMessage, operationGeneration })

  try {
    const result = await updateChecker.check()
    logInfo('[update] check completed', {
      visibleMessage,
      operationGeneration,
      status: result.status,
      version: result.status === 'available' ? result.update.version : undefined,
      distribution: result.status === 'available' ? result.capability.distribution : undefined,
      installStrategy: result.status === 'available' ? result.capability.installStrategy : undefined,
    })

    if (state.downloading || !updateOperationGate.isCurrent(operationGeneration)) {
      if (result.status === 'available') {
        await disposeUpdate(result.update)
        logWarn('[update] disposed stale check result', { operationGeneration, version: result.update.version })
      }
      if (visibleMessage) message.destroy(MESSAGE_KEY)
      return
    }

    if (result.status === 'available') {
      await transferUpdateOwnership(state.update, markRaw(result.update), (update) => {
        state.update = update
      })
      state.capability = result.capability
      const updateBody = result.update.body?.trim()
        || await fetchGitHubReleaseBody(GITHUB_LINK, result.update.version)
      state.updateBody = replaceBody(updateBody)
      state.updateDate = result.update.date
        ? dayjs.utc(result.update.date.split('.')[0]).local().format('YYYY-MM-DD HH:mm:ss')
        : ''

      showWindow()
      state.open = true
      message.destroy(MESSAGE_KEY)
    } else if (visibleMessage) {
      message.success({ key: MESSAGE_KEY, content: t('components.updateApp.hints.alreadyLatest') })
    }
  } catch (error) {
    logError('[update] check failed', { visibleMessage, operationGeneration, error })
    if (!visibleMessage) return

    message.error({
      key: MESSAGE_KEY,
      content: t('components.updateApp.hints.checkFailed', { error: String(error) }),
    })
  }
}

function clearUpdateState() {
  Object.assign(state, {
    open: false,
    update: undefined,
    capability: undefined,
    updateBody: '',
    updateDate: '',
  })
}

function handleCancel() {
  updateOperationGate.invalidateChecks()
  if (state.downloading) return

  const update = state.update

  clearUpdateState()
  if (update) {
    void disposeUpdate(update).catch((error) => {
      logWarn('[update] failed to dispose canceled update', { version: update.version, error })
    })
  }
}

onUnmounted(handleCancel)

function replaceBody(body: string) {
  return body
    .replace(/&nbsp;/g, '')
    .split('\n')
    .map(line => line.replace(/\s*-\s+by\s+@.*/, ''))
    .join('\n')
}

async function handleOk() {
  if (state.downloading || !state.update || !state.capability) return

  const version = state.update.version
  const capability = state.capability
  logStep('update', 'apply started', { version, ...capability })

  try {
    updateOperationGate.invalidateChecks()
    state.downloading = true

    const result = await applyUpdate(state.update, state.capability, GITHUB_LINK, {
      isWindows: platform() === 'windows',
      openUrl,
      relaunch,
      runAfterPersisting: runAfterSavingPersistentStores,
    }, (progress) => {
      switch (progress.event) {
        case 'Started':
          state.totalProgress = progress.data.contentLength
          state.downloadProgress = 0
          logInfo('[update] download started', { version, contentLength: progress.data.contentLength })
          break
        case 'Progress':
          state.downloadProgress += progress.data.chunkLength
          break
        case 'Finished':
          if (state.totalProgress) state.downloadProgress = state.totalProgress
          logInfo('[update] download finished', { version, downloadedBytes: state.downloadProgress })
          break
      }
    })

    logInfo('[update] apply completed', { version, result, ...capability })
    if (result === 'opened-download') clearUpdateState()
  } catch (error) {
    logError('[update] apply failed', { version, ...capability, error })
    message.error(t('components.updateApp.hints.updateFailed', { error: String(error) }))
  } finally {
    Object.assign(state, {
      downloading: false,
      totalProgress: undefined,
      downloadProgress: 0,
    })
  }
}
</script>

<template>
  <Modal
    v-model:open="state.open"
    :cancel-button-props="{ disabled: state.downloading }"
    :cancel-text="$t('components.updateApp.buttons.updateLater')"
    centered
    :closable="false"
    :mask-closable="false"
    :title="$t('components.updateApp.title')"
    @cancel="handleCancel"
    @ok="handleOk"
  >
    <template #okText>
      {{ state.downloading
        ? downloadProgress
        : $t(`components.updateApp.buttons.${installManually ? 'downloadUpdate' : 'updateNow'}`) }}
    </template>

    <Flex
      class="pt-1"
      gap="small"
      vertical
    >
      <Flex align="center">
        <span>{{ $t('components.updateApp.labels.updateVersion') }}</span>
        <span>
          <span>v{{ state.update?.currentVersion }} -&gt; </span>
          <a :href="releaseUrl">
            v{{ state.update?.version }}
          </a>
        </span>
      </Flex>

      <Flex align="center">
        <span>{{ $t('components.updateApp.labels.updateTime') }}</span>
        <span>{{ state.updateDate }}</span>
      </Flex>

      <span v-if="installManually">
        {{ $t('components.updateApp.hints.manualInstall') }}
      </span>

      <Flex vertical>
        <span>{{ $t('components.updateApp.labels.changelog') }}</span>

        <VueMarkdown
          class="update-note max-h-40 overflow-auto"
          :source="state.updateBody"
        />
      </Flex>
    </Flex>
  </Modal>
</template>

<style lang="scss" scoped>
.update-note {
  :not(a) {
    all: revert;
  }
}
</style>
