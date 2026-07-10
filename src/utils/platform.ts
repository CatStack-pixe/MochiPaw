// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { platform } from '@tauri-apps/plugin-os'

export const isMac = platform() === 'macos'

export const isWindows = platform() === 'windows'

export const isLinux = platform() === 'linux'
