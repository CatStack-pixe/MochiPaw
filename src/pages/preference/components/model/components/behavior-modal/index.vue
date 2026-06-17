<script setup lang="ts">
import type { ModelExpressionInfo, ModelMotionInfo } from '@/stores/model'

import { emit } from '@tauri-apps/api/event'
import { Empty, Modal } from 'antdv-next'
import { isEmpty } from 'es-toolkit/compat'
import { watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { LISTEN_KEY } from '@/constants'
import { useModelStore } from '@/stores/model'
import { resolveModelExpressions, resolveModelMotions } from '@/utils/live2d'

import BehaviorItem from './components/behavior-item/index.vue'

const modelValue = defineModel<boolean>()
const modelStore = useModelStore()
const { t } = useI18n()

function getMotionShortcutId(groupName: string, index: number) {
  return `${modelStore.currentModel?.id}:motion:${groupName}:${index}`
}

function getExpressionShortcutId(index: number) {
  return `${modelStore.currentModel?.id}:expression:${index}`
}

function startMotion(motion: ModelMotionInfo) {
  emit(LISTEN_KEY.START_MOTION, motion)
}

function setExpression(expression: ModelExpressionInfo, index: number) {
  emit(LISTEN_KEY.SET_EXPRESSION, { expression, index })
}

function getMotionNameId(groupName: string, index: number) {
  return `${getMotionShortcutId(groupName, index)}:name`
}

function getExpressionNameId(index: number) {
  return `${getExpressionShortcutId(index)}:name`
}

function getMotionDefaultLabel(motion: ModelMotionInfo, index: number) {
  return motion.displayName
    ?? motion.name
    ?? t('pages.preference.model.behaviorModal.labels.motionIndex', { index: index + 1 })
}

function getExpressionLabel(index: number) {
  return modelStore.currentExpressions[index]?.displayName
    ?? modelStore.currentExpressions[index]?.name
    ?? t('pages.preference.model.behaviorModal.labels.expressionIndex', { index: index + 1 })
}

function ensureBehaviorName(id: string, label: string) {
  if (modelStore.behaviorNames[id]) return

  modelStore.behaviorNames[id] = label
}

function ensureBehaviorNames() {
  for (const [, motions] of modelStore.currentMotions) {
    for (const [index, motion] of motions.entries()) {
      ensureBehaviorName(getMotionNameId(motion.group, index), getMotionDefaultLabel(motion, index))
    }
  }

  for (const [index] of modelStore.currentExpressions.entries()) {
    ensureBehaviorName(getExpressionNameId(index), getExpressionLabel(index))
  }
}

watch(modelValue, async (open) => {
  if (!open || !modelStore.currentModel) return

  modelStore.currentMotions = await resolveModelMotions(
    modelStore.currentModel.path,
    modelStore.currentMotions.flatMap(([, motions]) => motions),
  )

  if (!isEmpty(modelStore.currentExpressions)) {
    modelStore.currentExpressions = await resolveModelExpressions(
      modelStore.currentModel.path,
      modelStore.currentExpressions,
    )
  }

  ensureBehaviorNames()
})
</script>

<template>
  <Modal
    v-model:open="modelValue"
    :cancel-text="false"
    centered
    :footer="null"
    force-render
    :title="$t('pages.preference.model.behaviorModal.title')"
  >
    <div class="max-h-[70vh] flex flex-col gap-5 overflow-auto pr-1">
      <section class="flex flex-col gap-3">
        <div class="text-sm font-medium">
          {{ $t('pages.preference.model.behaviorModal.labels.motion') }}
        </div>

        <Empty
          v-if="isEmpty(modelStore.currentMotions)"
          :image="Empty.PRESENTED_IMAGE_SIMPLE"
        />

      <template v-else>
        <div
          v-for="([groupName, motions], groupIndex) in modelStore.currentMotions"
          :key="groupName"
        >
          <div class="mb-2">
            {{ $t('pages.preference.model.behaviorModal.labels.motionGroupIndex', { index: groupIndex + 1 }) }}
          </div>

          <div class="b-1 b-solid b-border rounded-lg">
            <template
              v-for="(item, index) in motions"
              :key="item.no"
            >
              <BehaviorItem
                v-model:name="modelStore.behaviorNames[getMotionNameId(groupName, index)]"
                v-model:shortcut="modelStore.shortcuts[getMotionShortcutId(groupName, index)]"
                @click="startMotion(item)"
              />
            </template>
          </div>
        </div>
        </template>
      </section>

      <section class="flex flex-col gap-3">
        <div class="text-sm font-medium">
          {{ $t('pages.preference.model.behaviorModal.labels.expression') }}
        </div>

        <Empty
          v-if="isEmpty(modelStore.currentExpressions)"
          :image="Empty.PRESENTED_IMAGE_SIMPLE"
        />

        <div
          v-else
          class="b-1 b-solid b-border rounded-lg"
        >
          <template
            v-for="(item, index) in modelStore.currentExpressions"
            :key="item.name"
          >
            <BehaviorItem
              v-model:name="modelStore.behaviorNames[getExpressionNameId(index)]"
              v-model:shortcut="modelStore.shortcuts[getExpressionShortcutId(index)]"
              @click="setExpression(item, index)"
            />
          </template>
        </div>
      </section>
    </div>
  </Modal>
</template>
