<script setup lang="ts">
import { emit } from '@tauri-apps/api/event'
import { appDataDir } from '@tauri-apps/api/path'
import { open } from '@tauri-apps/plugin-dialog'
import { copyFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { Button, Flex, message } from 'antdv-next'
import { nanoid } from 'nanoid'
import { useI18n } from 'vue-i18n'

import ProListItem from '@/components/pro-list-item/index.vue'
import { LISTEN_KEY } from '@/constants'
import { useGeneralStore } from '@/stores/general'
import { applyFontFamily, getFontFamilyFromPath, loadCustomFont, unloadAllFonts } from '@/utils/font'
import { join } from '@/utils/path'

const generalStore = useGeneralStore()
const { t } = useI18n()

const FONT_EXTENSIONS = ['ttf', 'otf', 'woff', 'woff2']

async function handleUpload() {
  const selected = await open({
    multiple: false,
    filters: [
      {
        name: t('pages.preference.general.labels.customFont'),
        extensions: FONT_EXTENSIONS,
      },
    ],
  })

  if (!selected || typeof selected !== 'string') return

  try {
    const familyName = getFontFamilyFromPath(selected)

    if (!familyName) return
    const fontsDir = join(await appDataDir(), 'fonts')

    if (!await exists(fontsDir)) {
      await mkdir(fontsDir, { recursive: true })
    }

    const ext = selected.split('.').at(-1) ?? 'ttf'
    const destPath = join(fontsDir, `${nanoid()}.${ext}`)

    await copyFile(selected, destPath)
    await loadCustomFont(destPath, familyName)
    applyFontFamily(familyName)

    generalStore.appearance.fontFamily = familyName
    generalStore.appearance.fontPath = destPath

    emit(LISTEN_KEY.FONT_CHANGED, { fontPath: destPath, fontFamily: familyName })

    message.success(t('pages.preference.general.hints.fontImportSuccess'))
  } catch (error) {
    message.error(String(error))
  }
}

function handleReset() {
  unloadAllFonts()
  applyFontFamily(undefined)

  generalStore.appearance.fontFamily = undefined
  generalStore.appearance.fontPath = undefined

  emit(LISTEN_KEY.FONT_CHANGED, { fontPath: undefined, fontFamily: undefined })
}
</script>

<template>
  <ProListItem
    :description="$t('pages.preference.general.hints.customFont')"
    :title="$t('pages.preference.general.labels.customFont')"
  >
    <Flex
      align="center"
      gap="small"
    >
      <span
        v-if="generalStore.appearance.fontFamily"
        class="max-w-30 truncate"
        :style="{ fontFamily: `'${generalStore.appearance.fontFamily}', inherit` }"
      >
        {{ generalStore.appearance.fontFamily }}
      </span>

      <span
        v-else
        class="text-[--ant-color-text-tertiary]"
      >
        {{ $t('pages.preference.general.options.defaultFont') }}
      </span>

      <Button
        ghost
        size="small"
        type="primary"
        @click="handleUpload"
      >
        <template #icon>
          <span class="i-solar:upload-square-linear" />
        </template>

        {{ $t('pages.preference.general.buttons.importFont') }}
      </Button>

      <Button
        v-if="generalStore.appearance.fontFamily"
        size="small"
        @click="handleReset"
      >
        {{ $t('pages.preference.general.buttons.resetFont') }}
      </Button>
    </Flex>
  </ProListItem>
</template>
