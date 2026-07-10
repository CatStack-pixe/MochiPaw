// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

/* eslint-disable no-template-curly-in-string */
import type { Config } from 'release-it'

export default {
  git: {
    commitMessage: 'v${version}',
    tagName: 'v${version}',
  },
  npm: {
    publish: false,
  },
  hooks: {
    'after:bump': 'tsx scripts/release.ts',
  },
} satisfies Config
