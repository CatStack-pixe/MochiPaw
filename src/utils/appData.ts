// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { invoke } from '@tauri-apps/api/core'

type DataDirectoryInvoker = (command: string) => Promise<string>

/** Use the backend's storage root without falling back to a different data set. */
export function getAppDataDirectory(invokeCommand: DataDirectoryInvoker = invoke) {
  return invokeCommand('get_app_data_directory')
}
