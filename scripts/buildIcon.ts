// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { execSync } from 'node:child_process'
import { env, platform } from 'node:process'

(() => {
  const isMac = env.PLATFORM?.startsWith('macos') ?? platform === 'darwin'

  const logoName = isMac ? 'logo-mac' : 'logo'

  const command = `tauri icon src-tauri/assets/${logoName}.png`

  execSync(command, { stdio: 'inherit' })
})()
