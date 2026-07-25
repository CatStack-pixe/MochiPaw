<!-- SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { emitTo } from '@tauri-apps/api/event'
import { Button, Input, InputNumber, message, Modal, Popconfirm, Select, Switch } from 'antdv-next'
import { computed, nextTick, reactive, ref, toRaw, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { SubModelInstance } from '@/stores/model'

import { useTauriListen } from '@/composables/useTauriListen'
import { LISTEN_KEY } from '@/constants'
import { getModelDisplayName, getSubModelDisplayName, useModelStore } from '@/stores/model'
import { destroySubModelWindow, getSubModelWindowLabel, hideSubModelWindow, openSubModelWindow } from '@/utils/subModelWindow'

const { standalone = false } = defineProps<{
  standalone?: boolean
}>()
const modelStore = useModelStore()
const { t } = useI18n()
const selectedModelId = ref<string>()
const expandedIds = reactive(new Set<string>())
const models = computed(() => modelStore.models)
const modelOptions = computed(() => models.value.map(model => ({
  label: getModelDisplayName(model),
  value: model.id,
})))

watch(models, (items) => {
  if (items.some(model => model.id === selectedModelId.value)) return

  selectedModelId.value = items[0]?.id
}, { immediate: true })

useTauriListen<SubModelInstance>(LISTEN_KEY.SUB_MODEL_WINDOW_CHANGED, ({ payload }) => {
  const instance = modelStore.getSubModel(payload.id)

  if (!instance) return

  Object.assign(instance.window, payload.window)
})

useTauriListen<{ id: string, visible: boolean }>(LISTEN_KEY.SUB_MODEL_VISIBILITY_CHANGED, ({ payload }) => {
  const instance = modelStore.getSubModel(payload.id)

  if (instance) {
    instance.visible = payload.visible
  }
})

function getInstanceModel(instance: SubModelInstance) {
  return models.value.find(item => item.id === instance.modelId)
}

function getInstanceName(instance: SubModelInstance) {
  return getSubModelDisplayName(instance, getInstanceModel(instance))
}

function getInstanceModelName(instance: SubModelInstance) {
  const model = getInstanceModel(instance)

  return model ? getModelDisplayName(model) : instance.modelId
}

function getInstanceNote(instance: SubModelInstance) {
  return instance.note?.trim() ?? ''
}

function toggleExpanded(instanceId: string) {
  if (expandedIds.has(instanceId)) {
    expandedIds.delete(instanceId)
  } else {
    expandedIds.add(instanceId)
  }
}

async function notifyInstance(instance: SubModelInstance) {
  await nextTick()

  await emitTo(
    getSubModelWindowLabel(instance.id),
    LISTEN_KEY.UPDATE_SUB_MODEL,
    structuredClone(toRaw(instance)),
  ).catch(() => undefined)
}

async function saveInstanceText(instance: SubModelInstance, field: 'customName' | 'note') {
  instance[field] = instance[field]?.trim() ?? ''
  await notifyInstance(instance)
}

async function createInstance() {
  if (!selectedModelId.value) return

  const instance = modelStore.createSubModel(selectedModelId.value)

  try {
    await openSubModelWindow(instance)
    expandedIds.add(instance.id)
  } catch (error) {
    modelStore.removeSubModel(instance.id)
    message.error(String(error))
  }
}

function handleCreate() {
  if (modelStore.subModels.length < 2) {
    return createInstance()
  }

  Modal.confirm({
    title: t('pages.preference.subModel.hints.createTitle'),
    content: t('pages.preference.subModel.hints.createWarning'),
    onOk: createInstance,
  })
}

async function setVisible(instance: SubModelInstance, visible: boolean) {
  instance.visible = visible

  try {
    if (visible) {
      await openSubModelWindow(instance)
    } else {
      await hideSubModelWindow(instance.id)
    }

    await notifyInstance(instance)
  } catch (error) {
    instance.visible = !visible
    message.error(String(error))
  }
}

async function handleDelete(instance: SubModelInstance) {
  await destroySubModelWindow(instance.id)
  expandedIds.delete(instance.id)
  modelStore.removeSubModel(instance.id)
}
</script>

<template>
  <aside
    class="sub-model-manager"
    :class="{ 'sub-model-manager-standalone': standalone }"
  >
    <div class="sub-model-header">
      <div>
        <h2>{{ t('pages.preference.subModel.title') }}</h2>
        <span>{{ t('pages.preference.subModel.configured', { count: modelStore.subModels.length }) }}</span>
      </div>

      <Button
        :disabled="!selectedModelId"
        :title="t('pages.preference.subModel.actions.add')"
        type="primary"
        @click="handleCreate"
      >
        <i class="i-lucide:plus" />
      </Button>
    </div>

    <Select
      v-model:value="selectedModelId"
      class="w-full"
      :options="modelOptions"
    />

    <div
      v-if="!modelStore.subModels.length"
      class="sub-model-empty"
    >
      {{ t('pages.preference.subModel.empty') }}
    </div>

    <div class="sub-model-list">
      <section
        v-for="instance in modelStore.subModels"
        :key="instance.id"
        class="sub-model-item"
      >
        <div class="sub-model-item-header">
          <Button
            :aria-expanded="expandedIds.has(instance.id)"
            class="sub-model-collapse-button"
            size="small"
            :title="t(`pages.preference.subModel.actions.${expandedIds.has(instance.id) ? 'collapse' : 'expand'}`)"
            type="text"
            @click="toggleExpanded(instance.id)"
          >
            <i :class="expandedIds.has(instance.id) ? 'i-lucide:chevron-down' : 'i-lucide:chevron-right'" />
          </Button>

          <div class="sub-model-item-heading">
            <strong :title="getInstanceName(instance)">
              {{ getInstanceName(instance) }}
            </strong>
            <span
              v-if="instance.customName?.trim()"
              :title="getInstanceModelName(instance)"
            >
              {{ getInstanceModelName(instance) }}
            </span>
            <span
              v-if="getInstanceNote(instance)"
              class="sub-model-note"
              :title="getInstanceNote(instance)"
            >
              {{ getInstanceNote(instance) }}
            </span>
          </div>

          <div class="sub-model-item-actions">
            <Switch
              :checked="instance.visible"
              :title="t('pages.preference.subModel.actions.toggleVisibility')"
              @change="value => setVisible(instance, value)"
            />

            <Popconfirm
              :description="t('pages.preference.subModel.hints.delete')"
              :title="t('pages.preference.subModel.actions.delete')"
              @confirm="handleDelete(instance)"
            >
              <Button
                danger
                size="small"
                :title="t('pages.preference.subModel.actions.delete')"
              >
                <i class="i-lucide:trash-2" />
              </Button>
            </Popconfirm>
          </div>
        </div>

        <div
          v-if="expandedIds.has(instance.id)"
          class="sub-model-details"
        >
          <label class="sub-model-text-field">
            <span>{{ t('pages.preference.subModel.labels.customName') }}</span>
            <Input
              v-model:value="instance.customName"
              allow-clear
              :placeholder="getInstanceModelName(instance)"
              @blur="saveInstanceText(instance, 'customName')"
              @press-enter="saveInstanceText(instance, 'customName')"
            />
          </label>

          <label class="sub-model-text-field">
            <span>{{ t('pages.preference.subModel.labels.note') }}</span>
            <Input
              v-model:value="instance.note"
              allow-clear
              @blur="saveInstanceText(instance, 'note')"
              @press-enter="saveInstanceText(instance, 'note')"
            />
          </label>

          <Select
            v-model:value="instance.modelId"
            class="w-full"
            :options="modelOptions"
            @change="notifyInstance(instance)"
          />

          <div class="sub-model-options">
            <label>
              <span>{{ t('pages.preference.subModel.labels.showOnLaunch') }}</span>
              <Switch
                v-model:checked="instance.showOnLaunch"
                @change="notifyInstance(instance)"
              />
            </label>

            <label>
              <span>{{ t('pages.preference.subModel.labels.keyboard') }}</span>
              <Switch
                v-model:checked="instance.listeners.keyboard"
                @change="notifyInstance(instance)"
              />
            </label>

            <label>
              <span>{{ t('pages.preference.subModel.labels.mouse') }}</span>
              <Switch
                v-model:checked="instance.listeners.mouse"
                @change="notifyInstance(instance)"
              />
            </label>

            <label>
              <span>{{ t('pages.preference.subModel.labels.gamepad') }}</span>
              <Switch
                v-model:checked="instance.listeners.gamepad"
                @change="notifyInstance(instance)"
              />
            </label>

            <label>
              <span>{{ t('pages.preference.subModel.labels.typingBehavior') }}</span>
              <Switch
                v-model:checked="instance.listeners.typingBehavior"
                @change="notifyInstance(instance)"
              />
            </label>

            <label>
              <span>{{ t('pages.preference.subModel.labels.passThrough') }}</span>
              <Switch
                v-model:checked="instance.window.passThrough"
                @change="notifyInstance(instance)"
              />
            </label>

            <label>
              <span>{{ t('pages.preference.subModel.labels.alwaysOnTop') }}</span>
              <Switch
                v-model:checked="instance.window.alwaysOnTop"
                @change="notifyInstance(instance)"
              />
            </label>

            <label>
              <span>{{ t('pages.preference.subModel.labels.mirror') }}</span>
              <Switch
                v-model:checked="instance.appearance.mirror"
                @change="notifyInstance(instance)"
              />
            </label>

            <label>
              <span>{{ t('pages.preference.subModel.labels.mouseMirror') }}</span>
              <Switch
                v-model:checked="instance.appearance.mouseMirror"
                @change="notifyInstance(instance)"
              />
            </label>

            <label>
              <span>{{ t('pages.preference.subModel.labels.fps') }}</span>
              <InputNumber
                v-model:value="instance.appearance.maxFPS"
                :max="60"
                :min="1"
                @change="notifyInstance(instance)"
              />
            </label>

            <label>
              <span>{{ t('pages.preference.subModel.labels.scale') }}</span>
              <InputNumber
                v-model:value="instance.window.scale"
                :max="500"
                :min="10"
                @change="notifyInstance(instance)"
              />
            </label>

            <label>
              <span>{{ t('pages.preference.subModel.labels.opacity') }}</span>
              <InputNumber
                v-model:value="instance.window.opacity"
                :max="100"
                :min="10"
                @change="notifyInstance(instance)"
              />
            </label>

            <label>
              <span>{{ t('pages.preference.subModel.labels.radius') }}</span>
              <InputNumber
                v-model:value="instance.window.radius"
                :max="100"
                :min="0"
                @change="notifyInstance(instance)"
              />
            </label>
          </div>
        </div>
      </section>
    </div>
  </aside>
</template>

<style scoped lang="scss">
.sub-model-manager {
  width: 300px;
  flex: 0 0 300px;
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 12px;
  border-left: 1px solid var(--ant-color-border-secondary);
  padding-left: 16px;
}

.sub-model-manager-standalone {
  width: 100%;
  flex-basis: auto;
  border-left: 0;
  padding-left: 0;
}

.sub-model-header,
.sub-model-options label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.sub-model-item-header {
  display: grid;
  align-items: start;
  gap: 6px;
  grid-template-columns: 28px minmax(0, 1fr) auto;
}

.sub-model-collapse-button {
  width: 28px;
  padding-inline: 0;
}

.sub-model-item-heading {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.sub-model-item-heading strong,
.sub-model-item-heading span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sub-model-item-heading span {
  color: var(--ant-color-text-secondary);
  font-size: 12px;
}

.sub-model-item-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sub-model-details {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sub-model-text-field {
  display: grid;
  align-items: center;
  gap: 8px;
  grid-template-columns: 64px minmax(0, 1fr);
  color: var(--ant-color-text-secondary);
  font-size: 12px;
}

.sub-model-header h2 {
  margin: 0;
  font-size: 16px;
  letter-spacing: 0;
}

.sub-model-header span,
.sub-model-empty {
  color: var(--ant-color-text-secondary);
  font-size: 12px;
}

.sub-model-list {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}

.sub-model-item {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid var(--ant-color-border-secondary);
  padding-top: 12px;
}

.sub-model-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
}

.sub-model-options label {
  min-width: 0;
  color: var(--ant-color-text-secondary);
  font-size: 12px;
}

.sub-model-options :deep(.ant-input-number) {
  width: 72px;
}
</style>
