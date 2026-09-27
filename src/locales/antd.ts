// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Locale as AntdLocale } from 'antdv-next/dist/locale/index'

import antdEnUS from 'antdv-next/locale/en_US'
import antdPtBR from 'antdv-next/locale/pt_BR'
import antdViVN from 'antdv-next/locale/vi_VN'
import antdZhCN from 'antdv-next/locale/zh_CN'
import antdZhTW from 'antdv-next/locale/zh_TW'

import type { Language } from '@/stores/general'

import { LANGUAGE } from '@/constants'

const antdLanguage: Record<Language, AntdLocale> = {
  [LANGUAGE.ZH_CN]: antdZhCN,
  [LANGUAGE.ZH_TW]: antdZhTW,
  [LANGUAGE.EN_US]: antdEnUS,
  [LANGUAGE.VI_VN]: antdViVN,
  [LANGUAGE.PT_BR]: antdPtBR,
}

export function getAntdLocale(language: Language = LANGUAGE.EN_US) {
  return antdLanguage[language]
}
