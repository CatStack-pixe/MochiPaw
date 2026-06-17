import { invoke } from '@tauri-apps/api/core'

const COMMAND = {
  IS_RUNNING_AS_ADMINISTRATOR: 'plugin:admin-status|is_running_as_administrator',
  GET_PROCESS_METRICS: 'plugin:admin-status|get_process_metrics',
}

export interface ProcessMetrics {
  pid: number
  cpuUsage: number | null
  memoryBytes: number
  virtualMemoryBytes: number
  threadCount: number
  uptimeSeconds: number
}

export function isRunningAsAdministrator() {
  return invoke<boolean>(COMMAND.IS_RUNNING_AS_ADMINISTRATOR)
}

export function getProcessMetrics() {
  return invoke<ProcessMetrics>(COMMAND.GET_PROCESS_METRICS)
}
