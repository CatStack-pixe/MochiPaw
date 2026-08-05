<!-- SPDX-FileCopyrightText: 2025 ayangweb
  SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { emitTo } from '@tauri-apps/api/event'
import { exists, remove } from '@tauri-apps/plugin-fs'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { useElementSize } from '@vueuse/core'
import { Button, Card, Checkbox, Input, Masonry, message, Modal, Pagination, Popconfirm } from 'antdv-next'
import { computed, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { Model, ModelSwitchAcknowledgement, ModelSwitchRequest } from '@/stores/model'

import { useTauriListen } from '@/composables/useTauriListen'
import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { useCatStore } from '@/stores/cat'
import { getModelDisplayName, useModelStore } from '@/stores/model'
import { logError, logInfo, logStep, logTrace } from '@/utils/diagnostics'
import { withTimeout } from '@/utils/promise'
import { ensureRuntimeLease } from '@/utils/runtimeTelemetry'
import { destroySubModelWindow } from '@/utils/subModelWindow'

import BehaviorModal from './components/behavior-modal/index.vue'
import ModelPreview from './components/model-preview/index.vue'
import Upload from './components/upload/index.vue'

const catStore = useCatStore()
const modelStore = useModelStore()
const firstCardRef = useTemplateRef('firstCard')
const { height } = useElementSize(firstCardRef)
const { t } = useI18n()
const openBehaviorModal = ref(false)
const currentPage = ref(1)
const renameModelOpen = ref(false)
const renameModelTarget = ref<Model>()
const renameModelDraft = ref('')
const selectedModelIds = ref(new Set<string>())
const batchDeleting = ref(false)
const pendingModelSwitches = new Map<string, (acknowledgement: ModelSwitchAcknowledgement) => void>()

const PAGE_SIZE = 5
const MODEL_SWITCH_ACK_TIMEOUT_MS = 5_000

useTauriListen<ModelSwitchAcknowledgement>(LISTEN_KEY.MODEL_SWITCH_APPLIED, ({ payload }) => {
  const resolve = pendingModelSwitches.get(payload.requestId)

  if (!resolve) {
    logTrace('[model-switch] received acknowledgement without pending request', payload)
    return
  }

  pendingModelSwitches.delete(payload.requestId)
  logStep('model-switch', 'received main window acknowledgement', payload)
  resolve(payload)
})

function proofLabel(model: Model) {
  if (model.importKind === 'controlled') return t('pages.preference.model.proof.controlled')
  if (model.proofStatus === 'manifest-detected') return t('pages.preference.model.proof.signed')
  return t('pages.preference.model.proof.standard')
}

function authorSummary(model: Model) {
  return displayMetaValue(model.author?.displayName)
}

function authorMetaLines(model: Model) {
  const author = model.author

  if (!author) return []

  return [
    { label: t('pages.preference.model.meta.homepage'), value: displayMetaValue(author.homepage) },
    { label: t('pages.preference.model.meta.contact'), value: displayMetaValue(author.contact) },
    { label: t('pages.preference.model.meta.community'), value: displayMetaValue(author.community) },
    { label: t('pages.preference.model.meta.source'), value: displayMetaValue(author.source) },
    { label: t('pages.preference.model.meta.collaborators'), value: displayMetaList(author.collaborators) },
  ].filter(item => item.value)
}

function packageSummary(model: Model) {
  return displayMetaValue(model.packageId) || displayMetaValue(model.controlledRelease?.packageId)
}

function policySummary(model: Model) {
  if (!model.controlledRelease) return ''

  const parts = []
  if (model.controlledRelease.reimportRestricted) parts.push(t('pages.preference.model.policy.reimportRestricted'))
  if (model.controlledRelease.runtimeTelemetryRequired) parts.push(t('pages.preference.model.policy.runtimeTelemetryRequired'))
  if (model.controlledRelease.offlineLeaseAllowed) parts.push(t('pages.preference.model.policy.offlineLeaseAllowed'))
  return parts.join(' / ')
}

function modelTitle(model: Model) {
  return getModelDisplayName(model)
}

function modelFallbackTitle(model: Model) {
  return displayMetaValue(model.displayName) || model.id
}

function openRenameModel(model: Model) {
  renameModelTarget.value = model
  renameModelDraft.value = model.customName ?? ''
  renameModelOpen.value = true
}

function saveModelName() {
  const model = renameModelTarget.value

  if (!model) return

  model.customName = renameModelDraft.value.trim() || undefined
  renameModelOpen.value = false
  renameModelTarget.value = undefined
}

function displayMetaValue(value: unknown) {
  if (typeof value !== 'string') return ''

  const text = value.trim()
  if (!text || /^(?:none|null|undefined|n\/a)$/i.test(text)) return ''

  return text
}

function displayMetaList(values: unknown) {
  if (!Array.isArray(values)) return ''

  return values
    .map(displayMetaValue)
    .filter(Boolean)
    .join(', ')
}

function waitForFrames(count = 2) {
  return new Promise<void>((resolve) => {
    const wait = () => {
      if (count <= 0) {
        resolve()
        return
      }

      count -= 1
      requestAnimationFrame(wait)
    }

    requestAnimationFrame(wait)
  })
}

const pageCount = computed(() => {
  return Math.max(1, Math.ceil(modelStore.models.length / PAGE_SIZE))
})

const currentPageModels = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE
  return modelStore.models.slice(start, start + PAGE_SIZE)
})

const selectedModels = computed(() => {
  return currentPageModels.value.filter(model => selectedModelIds.value.has(model.id))
})

const selectedModelCount = computed(() => selectedModels.value.length)

const masonryItems = computed(() => {
  const items = currentPageModels.value.map((item) => {
    return {
      key: item.id,
      data: item,
    }
  })

  return [{ key: 'upload', data: null }, ...items]
})

watch(pageCount, (count) => {
  currentPage.value = Math.min(currentPage.value, count)
})

watch(currentPage, clearSelection)
watch(() => modelStore.currentModel?.id, deselectModel)

function clearSelection() {
  selectedModelIds.value = new Set()
}

function deselectModel(modelId?: string) {
  if (!modelId || !selectedModelIds.value.has(modelId)) return

  const nextSelection = new Set(selectedModelIds.value)
  nextSelection.delete(modelId)
  selectedModelIds.value = nextSelection
}

function isCurrentModel(model: Model) {
  return model.id === modelStore.currentModel?.id
}

function isModelSelected(model: Model) {
  return selectedModelIds.value.has(model.id)
}

function toggleModelSelection(model: Model) {
  if (model.isPreset || isCurrentModel(model) || batchDeleting.value) return

  const nextSelection = new Set(selectedModelIds.value)

  if (nextSelection.has(model.id)) {
    nextSelection.delete(model.id)
  } else {
    nextSelection.add(model.id)
  }

  selectedModelIds.value = nextSelection
}

function showImportedModels() {
  currentPage.value = pageCount.value
  clearSelection()
}

function waitForModelSwitchAcknowledgement(requestId: string) {
  return withTimeout(
    new Promise<ModelSwitchAcknowledgement>((resolve) => {
      pendingModelSwitches.set(requestId, resolve)
    }),
    MODEL_SWITCH_ACK_TIMEOUT_MS,
    `Main window did not acknowledge model switch within ${MODEL_SWITCH_ACK_TIMEOUT_MS / 1000} seconds.`,
  ).finally(() => {
    pendingModelSwitches.delete(requestId)
  })
}

async function handleToggle(nextModel: Model) {
  if (batchDeleting.value) {
    logTrace('[model-switch] ignored selection during batch deletion', { modelId: nextModel.id })
    return
  }

  if (modelStore.currentModel?.id === nextModel.id) {
    logTrace('[model-switch] ignored selection of current model', { modelId: nextModel.id })
    return
  }

  const previousModel = modelStore.currentModel
  const previousModelReady = modelStore.modelReady
  logInfo('[model-switch] requested', {
    previousModelId: previousModel?.id,
    previousModelPath: previousModel?.path,
    nextModelId: nextModel.id,
    nextModelPath: nextModel.path,
    nextModelMode: nextModel.mode,
    nextModelImportKind: nextModel.importKind,
    nextModelProofStatus: nextModel.proofStatus,
  })

  try {
    logStep('model-switch', 'prepare runtime lease', { modelId: nextModel.id, modelPath: nextModel.path })
    await ensureRuntimeLease(nextModel)
    logStep('model-switch', 'runtime lease ready', { modelId: nextModel.id, modelPath: nextModel.path })
  } catch (error) {
    logError('[model-switch] runtime preparation failed', { modelId: nextModel.id, modelPath: nextModel.path, error })
    message.error(String(error))
    return
  }

  logStep('model-switch', 'update current model', {
    previousModelId: previousModel?.id,
    nextModelId: nextModel.id,
  })
  modelStore.currentModel = nextModel

  const request: ModelSwitchRequest = {
    requestId: `${Date.now()}-${nextModel.id}`,
    model: {
      id: nextModel.id,
      path: nextModel.path,
      mode: nextModel.mode,
      isPreset: nextModel.isPreset,
      importKind: nextModel.importKind,
      proofStatus: nextModel.proofStatus,
    },
  }

  try {
    const acknowledgement = waitForModelSwitchAcknowledgement(request.requestId)
    logStep('model-switch', 'notify main window', request)
    await emitTo(WINDOW_LABEL.MAIN, LISTEN_KEY.MODEL_SWITCH_REQUESTED, request)
    logStep('model-switch', 'main window notification sent', request)
    const result = await acknowledgement

    if (!result.accepted) {
      throw new Error(result.reason || 'Main window rejected the model switch.')
    }

    logStep('model-switch', 'main window accepted model switch', result)
  } catch (error) {
    modelStore.currentModel = previousModel
    modelStore.modelReady = previousModelReady
    logError('[model-switch] main window notification failed', { ...request, error })
    message.error(String(error))
    return
  }

  logInfo('[model-switch] requested model is now current', { modelId: nextModel.id, modelPath: nextModel.path })
}

async function removeModel(item: Model) {
  const { id, path } = item
  const previousModels = modelStore.models.slice()
  const previousCurrentModel = modelStore.currentModel
  const previousModelReady = modelStore.modelReady
  const nextModels = previousModels.filter(model => model.id !== id)
  const deletingCurrentModel = id === previousCurrentModel?.id

  modelStore.models = nextModels

  if (deletingCurrentModel) {
    modelStore.modelReady = false
    modelStore.currentModel = nextModels[0]
  }

  try {
    await waitForFrames()

    if (await exists(path)) {
      await remove(path, { recursive: true })
    }

    const subModels = modelStore.subModels.filter(instance => instance.modelId === id)

    await Promise.all(subModels.map(instance => destroySubModelWindow(instance.id)))
    modelStore.removeSubModelsByModelId(id)
  } catch (error) {
    modelStore.models = previousModels

    if (deletingCurrentModel) {
      modelStore.currentModel = previousCurrentModel
      modelStore.modelReady = previousModelReady
    }

    throw error
  }
}

async function handleDelete(item: Model) {
  if (batchDeleting.value) return

  try {
    await removeModel(item)
    message.success(t('pages.preference.model.hints.deleteSuccess'))
  } catch (error) {
    message.error(String(error))
  } finally {
    clearSelection()
  }
}

async function executeBatchDelete(items: Model[]) {
  batchDeleting.value = true
  let successCount = 0
  const failedModels: string[] = []

  try {
    for (const item of items) {
      try {
        await removeModel(item)
        successCount += 1
      } catch (error) {
        failedModels.push(modelTitle(item))
        logError('[model-delete] batch item failed', { modelId: item.id, modelPath: item.path, error })
      }
    }

    if (failedModels.length) {
      message.error(t('pages.preference.model.hints.batchDeletePartial', {
        failedModels: failedModels.join(', '),
        successCount,
      }))
      return
    }

    message.success(t('pages.preference.model.hints.batchDeleteSuccess', { successCount }))
  } finally {
    batchDeleting.value = false
    clearSelection()
  }
}

function confirmBatchDelete() {
  const items = selectedModels.value.filter(model => !isCurrentModel(model)).slice()

  if (!items.length || batchDeleting.value) return

  Modal.confirm({
    content: t('pages.preference.model.hints.deleteSelectedModels', { count: items.length }),
    okText: t('pages.preference.model.labels.deleteSelected'),
    okType: 'danger',
    onOk: () => executeBatchDelete(items),
    title: t('pages.preference.model.labels.deleteSelected'),
  })
}
</script>

<template>
  <section class="model-manager">
    <div class="model-grid">
      <div class="model-batch-actions">
        <span
          aria-live="polite"
          class="model-selection-count"
        >
          {{ $t('pages.preference.model.labels.selectedCount', { count: selectedModelCount }) }}
        </span>

        <Button
          danger
          :disabled="selectedModelCount === 0 || batchDeleting"
          :loading="batchDeleting"
          @click="confirmBatchDelete"
        >
          <template #icon>
            <i class="i-lucide:trash-2" />
          </template>
          {{ $t('pages.preference.model.labels.deleteSelected') }}
        </Button>
      </div>

      <Masonry
        :key="currentPage"
        :columns="{ xs: 3, lg: 4, xxl: 6 }"
        :gutter="16"
        :items="masonryItems"
      >
        <template #itemRender="{ data, index }">
          <template v-if="!data">
            <Upload
              :style="{ height: `${height}px` }"
              @imported="showImportedModels"
            />
          </template>

          <Card
            v-else
            :ref="index === 1 ? 'firstCard' : void 0"
            :classes="{
              actions: `[&>li]:(flex justify-center) [&>li>span]:(inline-flex! justify-center text-4!)`,
            }"
            hoverable
            size="small"
            @click="handleToggle(data)"
          >
            <template #cover>
              <ModelPreview :model="data" />
            </template>

            <template #title>
              <div class="model-card-title">
                <div class="model-card-title-main">
                  <span
                    v-if="!data.isPreset"
                    class="model-select-control"
                    @click.stop
                  >
                    <Checkbox
                      :checked="isModelSelected(data)"
                      :disabled="isCurrentModel(data) || batchDeleting"
                      @change="toggleModelSelection(data)"
                    />
                  </span>
                  <span class="model-title-text">{{ modelTitle(data) }}</span>
                </div>
                <span class="model-proof-pill">{{ proofLabel(data) }}</span>
              </div>
            </template>

            <div class="model-card-meta">
              <div
                v-if="authorSummary(data)"
                class="meta-line"
              >
                <strong>{{ $t('pages.preference.model.meta.author') }}</strong>
                <span>{{ authorSummary(data) }}</span>
              </div>
              <div
                v-if="packageSummary(data)"
                class="meta-line"
              >
                <strong>{{ $t('pages.preference.model.meta.packageId') }}</strong>
                <span>{{ packageSummary(data) }}</span>
              </div>
              <div
                v-if="policySummary(data)"
                class="meta-line"
              >
                <strong>{{ $t('pages.preference.model.meta.policy') }}</strong>
                <span>{{ policySummary(data) }}</span>
              </div>
              <div
                v-if="displayMetaValue(data.author?.statement)"
                class="meta-statement"
              >
                {{ displayMetaValue(data.author?.statement) }}
              </div>
              <div
                v-for="item in authorMetaLines(data)"
                :key="item.label"
                class="meta-line"
              >
                <strong>{{ item.label }}</strong>
                <span>{{ item.value }}</span>
              </div>
            </div>

            <template #actions>
              <i
                class="i-lucide:circle-check"
                :class="{ 'text-success': data.id === modelStore.currentModel?.id }"
              />

              <i
                v-if="catStore.model.behavior && modelStore.currentModel?.id === data.id"
                class="i-lucide:smile"
                @click.stop="openBehaviorModal = true"
              />

              <i
                class="i-lucide:pencil"
                :title="$t('pages.preference.model.actions.rename')"
                @click.stop="openRenameModel(data)"
              />

              <i
                class="i-lucide:folder-open"
                @click.stop="revealItemInDir(data.path)"
              />

              <template v-if="!data.isPreset">
                <Popconfirm
                  :description="$t('pages.preference.model.hints.deleteModel')"
                  placement="topRight"
                  :title="$t('pages.preference.model.labels.deleteModel')"
                  @confirm="handleDelete(data)"
                >
                  <i
                    class="i-lucide:trash-2"
                    @click.stop
                  />
                </Popconfirm>
              </template>
            </template>
          </Card>
        </template>
      </Masonry>

      <div
        v-if="modelStore.models.length > PAGE_SIZE"
        class="model-pagination"
      >
        <Pagination
          v-model:current="currentPage"
          :page-size="PAGE_SIZE"
          :show-size-changer="false"
          :total="modelStore.models.length"
        />
      </div>
    </div>
  </section>

  <BehaviorModal
    v-if="catStore.model.behavior"
    v-model="openBehaviorModal"
  />

  <Modal
    v-model:open="renameModelOpen"
    :title="$t('pages.preference.model.actions.rename')"
    @ok="saveModelName"
  >
    <label class="rename-model-field">
      <span>{{ $t('pages.preference.model.labels.customName') }}</span>
      <Input
        v-model:value="renameModelDraft"
        allow-clear
        :placeholder="renameModelTarget ? modelFallbackTitle(renameModelTarget) : ''"
        @press-enter="saveModelName"
      />
      <small>{{ $t('pages.preference.model.hints.customName') }}</small>
    </label>
  </Modal>
</template>

<style scoped lang="scss">
.model-manager {
  display: grid;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  grid-template-rows: minmax(0, 1fr) auto;
}

.model-grid {
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 72px;
  position: relative;
  z-index: 0;
  isolation: isolate;
}

.model-batch-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  min-height: 40px;
  margin-bottom: 12px;
  padding: 8px 12px;
  border: 1px solid var(--ant-color-border);
  border-radius: 6px;
  background: var(--ant-color-fill-quaternary);
}

.model-selection-count {
  color: var(--ant-color-text-secondary);
  font-size: 13px;
}

.rename-model-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rename-model-field small {
  color: var(--ant-color-text-secondary);
}

.rename-model-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rename-model-field small {
  color: var(--ant-color-text-secondary);
}

.model-card-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.model-card-title-main {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}

.model-select-control {
  display: inline-flex;
  flex-shrink: 0;
}

.model-title-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-proof-pill {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  background: rgba(24, 144, 255, 0.12);
  color: #1677ff;
  font-size: 11px;
  line-height: 1;
  flex-shrink: 0;
}

.model-card-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 8px;
}

.meta-line {
  display: flex;
  gap: 6px;
  font-size: 12px;
  line-height: 1.4;

  strong {
    flex-shrink: 0;
    color: var(--ant-color-text);
  }

  span {
    min-width: 0;
    color: var(--ant-color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.meta-statement {
  font-size: 12px;
  line-height: 1.45;
  color: var(--ant-color-text-secondary);
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.model-pagination {
  display: flex;
  justify-content: center;
  padding: 12px 0;
  background: var(--ant-color-fill-quaternary);
  position: fixed;
  z-index: 2;
  right: 16px;
  bottom: 16px;
  left: calc(7.5rem + 16px);
}
</style>
