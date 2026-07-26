<!-- SPDX-FileCopyrightText: 2025 ayangweb
  SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { exists, remove } from '@tauri-apps/plugin-fs'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { useElementSize } from '@vueuse/core'
import { Card, Input, Masonry, message, Modal, Pagination, Popconfirm } from 'antdv-next'
import { computed, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { Model } from '@/stores/model'

import { useCatStore } from '@/stores/cat'
import { getModelDisplayName, useModelStore } from '@/stores/model'
import { ensureRuntimeLease, reportRuntimeEventQuietly } from '@/utils/runtimeTelemetry'
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

const PAGE_SIZE = 5

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

const masonryItems = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE
  const items = modelStore.models.slice(start, start + PAGE_SIZE).map((item) => {
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

function showImportedModels() {
  currentPage.value = pageCount.value
}

async function handleToggle(nextModel: Model) {
  if (modelStore.currentModel?.id === nextModel.id) return

  try {
    await ensureRuntimeLease(nextModel)
  } catch (error) {
    message.error(String(error))
    return
  }

  modelStore.modelReady = false

  modelStore.currentModel = nextModel
  reportRuntimeEventQuietly(nextModel, 'opened')
}

async function handleDelete(item: Model) {
  const { id, path } = item
  const previousModels = modelStore.models
  const previousCurrentModel = modelStore.currentModel
  const nextModels = previousModels.filter(model => model.id !== id)
  const isCurrentModel = id === previousCurrentModel?.id

  modelStore.models = nextModels

  if (isCurrentModel) {
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

    message.success(t('pages.preference.model.hints.deleteSuccess'))
  } catch (error) {
    modelStore.models = previousModels

    if (isCurrentModel) {
      modelStore.currentModel = previousCurrentModel
    }

    message.error(String(error))
  }
}
</script>

<template>
  <section class="model-manager">
    <div class="model-grid">
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
                <span class="model-title-text">{{ modelTitle(data) }}</span>
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
