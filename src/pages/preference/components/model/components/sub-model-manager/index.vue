<!-- SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { emitTo } from '@tauri-apps/api/event'
import { Button, InputNumber, message, Modal, Popconfirm, Select, Switch } from 'antdv-next'
import { computed, ref, toRaw, watch } from 'vue'

import type { Model, SubModelInstance } from '@/stores/model'

import { useTauriListen } from '@/composables/useTauriListen'
import { LISTEN_KEY } from '@/constants'
import { useModelStore } from '@/stores/model'
import { destroySubModelWindow, getSubModelWindowLabel, hideSubModelWindow, openSubModelWindow } from '@/utils/subModelWindow'

const { standalone = false } = defineProps<{
  standalone?: boolean
}>()
const modelStore = useModelStore()
const selectedModelId = ref<string>()
const models = computed(() => modelStore.models)
const modelOptions = computed(() => models.value.map(model => ({
  label: modelName(model),
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

function modelName(model: Model) {
  return model.displayName?.trim() || model.id
}

function getModelName(instance: SubModelInstance) {
  const model = models.value.find(item => item.id === instance.modelId)

  return model ? modelName(model) : instance.modelId
}

async function notifyInstance(instance: SubModelInstance) {
  await emitTo(
    getSubModelWindowLabel(instance.id),
    LISTEN_KEY.UPDATE_SUB_MODEL,
    structuredClone(toRaw(instance)),
  ).catch(() => undefined)
}

async function createInstance() {
  if (!selectedModelId.value) return

  const instance = modelStore.createSubModel(selectedModelId.value)

  try {
    await openSubModelWindow(instance)
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
    title: 'Create another sub model?',
    content: 'More visible models require additional CPU, GPU, and memory.',
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
        <h2>Sub models</h2>
        <span>{{ modelStore.subModels.length }} configured</span>
      </div>

      <Button
        :disabled="!selectedModelId"
        title="Add sub model"
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
      No sub models
    </div>

    <div class="sub-model-list">
      <section
        v-for="instance in modelStore.subModels"
        :key="instance.id"
        class="sub-model-item"
      >
        <div class="sub-model-item-header">
          <strong>{{ getModelName(instance) }}</strong>

          <div class="flex items-center gap-2">
            <Switch
              :checked="instance.visible"
              title="Show sub model"
              @change="value => setVisible(instance, value)"
            />

            <Popconfirm
              description="This removes the sub model and its window settings."
              title="Remove sub model?"
              @confirm="handleDelete(instance)"
            >
              <Button
                danger
                size="small"
                title="Remove sub model"
              >
                <i class="i-lucide:trash-2" />
              </Button>
            </Popconfirm>
          </div>
        </div>

        <Select
          v-model:value="instance.modelId"
          class="w-full"
          :options="modelOptions"
          @change="notifyInstance(instance)"
        />

        <div class="sub-model-options">
          <label>
            <span>Show on launch</span>
            <Switch
              v-model:checked="instance.showOnLaunch"
              @change="notifyInstance(instance)"
            />
          </label>

          <label>
            <span>Keyboard</span>
            <Switch
              v-model:checked="instance.listeners.keyboard"
              @change="notifyInstance(instance)"
            />
          </label>

          <label>
            <span>Mouse</span>
            <Switch
              v-model:checked="instance.listeners.mouse"
              @change="notifyInstance(instance)"
            />
          </label>

          <label>
            <span>Gamepad</span>
            <Switch
              v-model:checked="instance.listeners.gamepad"
              @change="notifyInstance(instance)"
            />
          </label>

          <label>
            <span>Typing behavior</span>
            <Switch
              v-model:checked="instance.listeners.typingBehavior"
              @change="notifyInstance(instance)"
            />
          </label>

          <label>
            <span>Pass through</span>
            <Switch
              v-model:checked="instance.window.passThrough"
              @change="notifyInstance(instance)"
            />
          </label>

          <label>
            <span>Always on top</span>
            <Switch
              v-model:checked="instance.window.alwaysOnTop"
              @change="notifyInstance(instance)"
            />
          </label>

          <label>
            <span>Mirror</span>
            <Switch
              v-model:checked="instance.appearance.mirror"
              @change="notifyInstance(instance)"
            />
          </label>

          <label>
            <span>Mouse mirror</span>
            <Switch
              v-model:checked="instance.appearance.mouseMirror"
              @change="notifyInstance(instance)"
            />
          </label>

          <label>
            <span>FPS</span>
            <InputNumber
              v-model:value="instance.appearance.maxFPS"
              :max="60"
              :min="1"
              @change="notifyInstance(instance)"
            />
          </label>

          <label>
            <span>Scale</span>
            <InputNumber
              v-model:value="instance.window.scale"
              :max="500"
              :min="10"
              @change="notifyInstance(instance)"
            />
          </label>

          <label>
            <span>Opacity</span>
            <InputNumber
              v-model:value="instance.window.opacity"
              :max="100"
              :min="10"
              @change="notifyInstance(instance)"
            />
          </label>

          <label>
            <span>Radius</span>
            <InputNumber
              v-model:value="instance.window.radius"
              :max="100"
              :min="0"
              @change="notifyInstance(instance)"
            />
          </label>
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
.sub-model-item-header,
.sub-model-options label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
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
