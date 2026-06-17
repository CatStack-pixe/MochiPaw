<script setup lang="ts">
import type { ModelBehaviorConfig, ModelExpressionInfo, ModelMotionInfo, ModelMotionTarget } from '@/stores/model'

import { emit } from '@tauri-apps/api/event'
import { Empty, Modal } from 'antdv-next'
import { groupBy, isEmpty } from 'es-toolkit/compat'
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

function startMotion(motion: ModelMotionInfo, index: number) {
  const config = getBehaviorConfig(getMotionShortcutId(motion.group, index), motion.group)

  emit(LISTEN_KEY.START_MOTION, {
    motion,
    config,
    mutexTargets: getMotionMutexTargets(motion, config),
  })
}

function setExpression(expression: ModelExpressionInfo, index: number) {
  const config = getBehaviorConfig(getExpressionShortcutId(index), 'expression')

  emit(LISTEN_KEY.SET_EXPRESSION, {
    expression,
    index,
    config,
    mutexTargets: getExpressionMutexTargets(expression, config),
  })
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

function getDefaultBehaviorConfig(group: string, mutexGroup = group): ModelBehaviorConfig {
  return {
    group,
    mutexGroup,
    resetDelay: 0.8,
  }
}

function ensureBehaviorConfig(id: string, group: string, mutexGroup = group) {
  modelStore.behaviorConfigs[id] ??= getDefaultBehaviorConfig(group, mutexGroup)
}

function getBehaviorConfig(id: string, group: string, mutexGroup = group) {
  ensureBehaviorConfig(id, group, mutexGroup)

  return modelStore.behaviorConfigs[id]
}

function ensureBehaviorNames() {
  for (const [, motions] of modelStore.currentMotions) {
    for (const [index, motion] of motions.entries()) {
      const id = getMotionShortcutId(motion.group, index)

      ensureBehaviorName(getMotionNameId(motion.group, index), getMotionDefaultLabel(motion, index))
      ensureBehaviorConfig(id, motion.group)
    }
  }

  for (const [index] of modelStore.currentExpressions.entries()) {
    const id = getExpressionShortcutId(index)

    ensureBehaviorName(getExpressionNameId(index), getExpressionLabel(index))
    ensureBehaviorConfig(id, 'expression')
  }
}

function uniqueTargets(targets: ModelMotionTarget[]) {
  const targetMap = new Map<string, ModelMotionTarget>()

  for (const target of targets) {
    targetMap.set(target.id, target)
  }

  return [...targetMap.values()]
}

function getMotionMutexTargets(currentMotion: ModelMotionInfo, currentConfig: ModelBehaviorConfig) {
  return uniqueTargets(modelStore.currentMotions.flatMap(([groupName, motions]) => {
    return motions.flatMap((motion, index) => {
      if (motion === currentMotion) return []

      const config = getBehaviorConfig(getMotionShortcutId(groupName, index), groupName)

      if (!config.mutexGroup || config.mutexGroup !== currentConfig.mutexGroup) return []

      return motion.defaultTargets ?? []
    })
  }))
}

function getExpressionMutexTargets(currentExpression: ModelExpressionInfo, currentConfig: ModelBehaviorConfig) {
  return uniqueTargets(modelStore.currentExpressions.flatMap((expression, index) => {
    if (expression === currentExpression) return []

    const config = getBehaviorConfig(getExpressionShortcutId(index), 'expression')

    if (!config.mutexGroup || config.mutexGroup !== currentConfig.mutexGroup) return []

    return expression.defaultTargets ?? []
  }))
}

watch(modelValue, async (open) => {
  if (!open || !modelStore.currentModel) return

  const motions = await resolveModelMotions(
    modelStore.currentModel.path,
    modelStore.currentMotions.flatMap(([, motions]) => motions),
  )

  modelStore.currentMotions = Object.entries(groupBy(motions, 'group'))

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
    width="900px"
  >
    <div class="grid max-h-[70vh] grid-cols-1 gap-5 overflow-auto pr-1 lg:grid-cols-2">
      <section class="min-w-0 flex flex-col gap-3">
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
                  v-model:config="modelStore.behaviorConfigs[getMotionShortcutId(groupName, index)]"
                  v-model:name="modelStore.behaviorNames[getMotionNameId(groupName, index)]"
                  v-model:shortcut="modelStore.shortcuts[getMotionShortcutId(groupName, index)]"
                  @click="startMotion(item, index)"
                />
              </template>
            </div>
          </div>
        </template>
      </section>

      <section class="min-w-0 flex flex-col gap-3">
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
              v-model:config="modelStore.behaviorConfigs[getExpressionShortcutId(index)]"
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
