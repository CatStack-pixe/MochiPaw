// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { createI18n } from 'vue-i18n'

import { LANGUAGE } from '@/constants'

import enUS from './en-US.json'
import ptBR from './pt-BR.json'
import viVN from './vi-VN.json'
import zhCN from './zh-CN.json'
import zhTW from './zh-TW.json'

export const i18n = createI18n({
  legacy: false,
  locale: LANGUAGE.EN_US,
  fallbackLocale: LANGUAGE.EN_US,
  messages: {
    [LANGUAGE.ZH_CN]: zhCN,
    [LANGUAGE.ZH_TW]: zhTW,
    [LANGUAGE.EN_US]: enUS,
    [LANGUAGE.VI_VN]: viVN,
    [LANGUAGE.PT_BR]: ptBR,
  },
})
