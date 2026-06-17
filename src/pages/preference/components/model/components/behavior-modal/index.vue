<script setup lang="ts">
import type {
  ModelBehaviorConfig,
  ModelBehaviorGroupConfig,
  ModelExpressionInfo,
  ModelMotionInfo,
  ModelMotionTarget,
} from '@/stores/model'

import { emit } from '@tauri-apps/api/event'
import { Empty, Input, InputNumber, Modal } from 'antdv-next'
import { groupBy, isEmpty } from 'es-toolkit/compat'
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { LISTEN_KEY } from '@/constants'
import { useModelStore } from '@/stores/model'
import { resolveModelExpressions, resolveModelMotions } from '@/utils/live2d'

import BehaviorItem from './components/behavior-item/index.vue'

interface BehaviorMotionGroup {
  key: string
  title: string
  motions: ModelMotionInfo[]
}

interface BehaviorExpressionGroup {
  key: string
  title: string
  expressions: Array<{
    expression: ModelExpressionInfo
    index: number
  }>
}

const modelValue = defineModel<boolean>()
const modelStore = useModelStore()
const { t } = useI18n()

const motionGroups = computed<BehaviorMotionGroup[]>(() => {
  const groups = groupBy(
    modelStore.currentMotions.flatMap(([, motions]) => motions),
    motion => getBehaviorConfig(getMotionShortcutId(motion.group, motion.no), motion.group).group,
  )

  return Object.entries(groups).map(([key, motions], index) => ({
    key,
    title: key || t('pages.preference.model.behaviorModal.labels.motionGroupIndex', { index: index + 1 }),
    motions,
  }))
})

const expressionGroups = computed<BehaviorExpressionGroup[]>(() => {
  const groups = groupBy(
    modelStore.currentExpressions.map((expression, index) => ({ expression, index })),
    item => getBehaviorConfig(getExpressionShortcutId(item.index), 'expression').group,
  )

  return Object.entries(groups).map(([key, expressions], index) => ({
    key,
    title: key || t('pages.preference.model.behaviorModal.labels.expressionGroupIndex', { index: index + 1 }),
    expressions,
  }))
})

function getMotionShortcutId(groupName: string, index: number) {
  return `${modelStore.currentModel?.id}:motion:${groupName}:${index}`
}

function getExpressionShortcutId(index: number) {
  return `${modelStore.currentModel?.id}:expression:${index}`
}

function getBehaviorGroupConfigId(group: string) {
  return `${modelStore.currentModel?.id}:behavior-group:${group}`
}

function getMotionNameId(groupName: string, index: number) {
  return `${getMotionShortcutId(groupName, index)}:name`
}

function getExpressionNameId(index: number) {
  return `${getExpressionShortcutId(index)}:name`
}

function startMotion(motion: ModelMotionInfo) {
  const config = getBehaviorConfig(getMotionShortcutId(motion.group, motion.no), motion.group)
  const groupConfig = getBehaviorGroupConfig(config.group)

  emit(LISTEN_KEY.START_MOTION, {
    motion,
    config: toPlayConfig(config, groupConfig),
    mutexTargets: getMotionMutexTargets(motion, config, groupConfig),
  })
}

function setExpression(expression: ModelExpressionInfo, index: number) {
  const config = getBehaviorConfig(getExpressionShortcutId(index), 'expression')
  const groupConfig = getBehaviorGroupConfig(config.group)

  emit(LISTEN_KEY.SET_EXPRESSION, {
    expression,
    index,
    config: toPlayConfig(config, groupConfig),
    mutexTargets: getExpressionMutexTargets(expression, config, groupConfig),
  })
}

function toPlayConfig(config: ModelBehaviorConfig, groupConfig: ModelBehaviorGroupConfig): Required<ModelBehaviorConfig> {
  return {
    group: config.group,
    mutexGroup: groupConfig.mutexGroup,
    resetDelay: groupConfig.resetDelay,
  }
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

function ensureBehaviorConfig(id: string, group: string) {
  modelStore.behaviorConfigs[id] ??= { group }
  modelStore.behaviorConfigs[id].group ||= group

  const legacyMutexGroup = modelStore.behaviorConfigs[id].mutexGroup
  const legacyResetDelay = modelStore.behaviorConfigs[id].resetDelay

  ensureBehaviorGroupConfig(modelStore.behaviorConfigs[id].group, legacyMutexGroup, legacyResetDelay)

  delete modelStore.behaviorConfigs[id].mutexGroup
  delete modelStore.behaviorConfigs[id].resetDelay
}

function getBehaviorConfig(id: string, group: string) {
  ensureBehaviorConfig(id, group)

  return modelStore.behaviorConfigs[id]
}

function ensureBehaviorGroupConfig(group: string, mutexGroup = group, resetDelay = 0.8) {
  const id = getBehaviorGroupConfigId(group)

  modelStore.behaviorGroupConfigs[id] ??= {
    mutexGroup,
    resetDelay,
  }

  modelStore.behaviorGroupConfigs[id].mutexGroup ||= mutexGroup || group
}

function getBehaviorGroupConfig(group: string) {
  ensureBehaviorGroupConfig(group)

  return modelStore.behaviorGroupConfigs[getBehaviorGroupConfigId(group)]
}

function renameBehaviorGroup(oldGroup: string, nextGroup: string) {
  const group = nextGroup || oldGroup

  if (group !== oldGroup) {
    modelStore.behaviorGroupConfigs[getBehaviorGroupConfigId(group)] ??= { ...getBehaviorGroupConfig(oldGroup) }
  }

  for (const config of Object.values(modelStore.behaviorConfigs)) {
    if (config.group === oldGroup) {
      config.group = group
    }
  }
}

function ensureBehaviorSettings() {
  for (const [, motions] of modelStore.currentMotions) {
    for (const [index, motion] of motions.entries()) {
      const id = getMotionShortcutId(motion.group, motion.no)

      ensureBehaviorName(getMotionNameId(motion.group, motion.no), getMotionDefaultLabel(motion, index))
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

function getMotionMutexTargets(
  currentMotion: ModelMotionInfo,
  currentConfig: ModelBehaviorConfig,
  currentGroupConfig: ModelBehaviorGroupConfig,
) {
  return uniqueTargets(modelStore.currentMotions.flatMap(([, motions]) => {
    return motions.flatMap((motion) => {
      if (motion === currentMotion) return []

      const config = getBehaviorConfig(getMotionShortcutId(motion.group, motion.no), motion.group)
      const groupConfig = getBehaviorGroupConfig(config.group)

      if (!currentGroupConfig.mutexGroup || groupConfig.mutexGroup !== currentGroupConfig.mutexGroup) return []
      if (config.group === currentConfig.group) return []

      return motion.defaultTargets ?? []
    })
  }))
}

function getExpressionMutexTargets(
  currentExpression: ModelExpressionInfo,
  currentConfig: ModelBehaviorConfig,
  currentGroupConfig: ModelBehaviorGroupConfig,
) {
  return uniqueTargets(modelStore.currentExpressions.flatMap((expression, index) => {
    if (expression === currentExpression) return []

    const config = getBehaviorConfig(getExpressionShortcutId(index), 'expression')
    const groupConfig = getBehaviorGroupConfig(config.group)

    if (!currentGroupConfig.mutexGroup || groupConfig.mutexGroup !== currentGroupConfig.mutexGroup) return []
    if (config.group === currentConfig.group) return []

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

  ensureBehaviorSettings()
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
    width="980px"
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
            v-for="group in motionGroups"
            :key="group.key"
            class="b-1 b-solid b-border rounded-lg"
          >
            <div class="grid gap-2 bg-fill-sec px-4 py-3">
              <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem] gap-2 text-[11px] text-text-tertiary">
                <span>Group</span>
                <span>Mutex</span>
                <span>Reset</span>
              </div>

              <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem] gap-2">
                <Input
                  :value="group.key"
                  size="small"
                  @update:value="renameBehaviorGroup(group.key, String($event))"
                />

                <Input
                  v-model:value="modelStore.behaviorGroupConfigs[getBehaviorGroupConfigId(group.key)].mutexGroup"
                  size="small"
                />

                <InputNumber
                  v-model:value="modelStore.behaviorGroupConfigs[getBehaviorGroupConfigId(group.key)].resetDelay"
                  class="w-full"
                  :min="-1"
                  :precision="1"
                  size="small"
                  :step="0.1"
                />
              </div>
            </div>

            <BehaviorItem
              v-for="item in group.motions"
              :key="`${item.group}:${item.no}`"
              v-model:config="modelStore.behaviorConfigs[getMotionShortcutId(item.group, item.no)]"
              v-model:name="modelStore.behaviorNames[getMotionNameId(item.group, item.no)]"
              v-model:shortcut="modelStore.shortcuts[getMotionShortcutId(item.group, item.no)]"
              @click="startMotion(item)"
            />
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

        <template v-else>
          <div
            v-for="group in expressionGroups"
            :key="group.key"
            class="b-1 b-solid b-border rounded-lg"
          >
            <div class="grid gap-2 bg-fill-sec px-4 py-3">
              <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem] gap-2 text-[11px] text-text-tertiary">
                <span>Group</span>
                <span>Mutex</span>
                <span>Reset</span>
              </div>

              <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem] gap-2">
                <Input
                  :value="group.key"
                  size="small"
                  @update:value="renameBehaviorGroup(group.key, String($event))"
                />

                <Input
                  v-model:value="modelStore.behaviorGroupConfigs[getBehaviorGroupConfigId(group.key)].mutexGroup"
                  size="small"
                />

                <InputNumber
                  v-model:value="modelStore.behaviorGroupConfigs[getBehaviorGroupConfigId(group.key)].resetDelay"
                  class="w-full"
                  :min="-1"
                  :precision="1"
                  size="small"
                  :step="0.1"
                />
              </div>
            </div>

            <BehaviorItem
              v-for="{ expression, index } in group.expressions"
              :key="expression.name"
              v-model:config="modelStore.behaviorConfigs[getExpressionShortcutId(index)]"
              v-model:name="modelStore.behaviorNames[getExpressionNameId(index)]"
              v-model:shortcut="modelStore.shortcuts[getExpressionShortcutId(index)]"
              @click="setExpression(expression, index)"
            />
          </div>
        </template>
      </section>
    </div>
  </Modal>
</template>
