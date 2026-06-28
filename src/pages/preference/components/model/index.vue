<script setup lang="ts">
import { exists, remove } from '@tauri-apps/plugin-fs'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { useElementSize } from '@vueuse/core'
import { Card, Masonry, message, Popconfirm } from 'antdv-next'
import { computed, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'

import type { Model } from '@/stores/model'

import { useCatStore } from '@/stores/cat'
import { useModelStore } from '@/stores/model'

import BehaviorModal from './components/behavior-modal/index.vue'
import FloatMenu from './components/float-menu/index.vue'
import ModelPreview from './components/model-preview/index.vue'
import Upload from './components/upload/index.vue'

const catStore = useCatStore()
const modelStore = useModelStore()
const firstCardRef = useTemplateRef('firstCard')
const { height } = useElementSize(firstCardRef)
const { t } = useI18n()
const openBehaviorModal = ref(false)

function proofLabel(model: Model) {
  if (model.importKind === 'controlled') return t('pages.preference.model.proof.controlled')
  if (model.proofStatus === 'manifest-detected') return t('pages.preference.model.proof.signed')
  return t('pages.preference.model.proof.standard')
}

function authorSummary(model: Model) {
  return model.author?.displayName?.trim() ?? ''
}

function authorMetaLines(model: Model) {
  const author = model.author

  if (!author) return []

  return [
    { label: t('pages.preference.model.meta.homepage'), value: author.homepage?.trim() ?? '' },
    { label: t('pages.preference.model.meta.contact'), value: author.contact?.trim() ?? '' },
    { label: t('pages.preference.model.meta.community'), value: author.community?.trim() ?? '' },
    { label: t('pages.preference.model.meta.source'), value: author.source?.trim() ?? '' },
    { label: t('pages.preference.model.meta.collaborators'), value: author.collaborators?.filter(Boolean).join(', ') ?? '' },
  ].filter(item => item.value)
}

function packageSummary(model: Model) {
  return model.packageId?.trim() ?? model.controlledRelease?.packageId?.trim() ?? ''
}

function policySummary(model: Model) {
  if (!model.controlledRelease) return ''

  const parts = []
  if (model.controlledRelease.reimportRestricted) parts.push(t('pages.preference.model.policy.reimportRestricted'))
  if (model.controlledRelease.runtimeTelemetryRequired) parts.push(t('pages.preference.model.policy.runtimeTelemetryRequired'))
  if (model.controlledRelease.offlineLeaseAllowed) parts.push(t('pages.preference.model.policy.offlineLeaseAllowed'))
  return parts.join(' / ')
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

const masonryItems = computed(() => {
  const items = modelStore.models.map((item) => {
    return {
      key: item.id,
      data: item,
    }
  })

  return [{ key: 'upload', data: null }, ...items]
})

function handleToggle(nextModel: Model) {
  if (modelStore.currentModel?.id === nextModel.id) return

  modelStore.modelReady = false

  modelStore.currentModel = nextModel
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
  <Masonry
    :columns="{ xs: 3, lg: 4, xxl: 6 }"
    :gutter="16"
    :items="masonryItems"
  >
    <template #itemRender="{ data, index }">
      <template v-if="!data">
        <Upload :style="{ height: `${height}px` }" />
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
            <span>{{ data.id }}</span>
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
            v-if="data.author?.statement"
            class="meta-statement"
          >
            {{ data.author.statement }}
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

  <FloatMenu />

  <BehaviorModal
    v-if="catStore.model.behavior"
    v-model="openBehaviorModal"
  />
</template>

<style scoped lang="scss">
.model-card-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
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
</style>
