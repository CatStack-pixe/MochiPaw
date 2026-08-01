// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export interface ImportSource {
  path: string
  temporaryDirectory?: string
}

type Cleanup = (path: string) => Promise<void>
type Warn = (error: unknown) => void

export async function extractTemporaryImportSource(
  fromPath: string,
  temporaryDirectory: string,
  extract: (fromPath: string, toPath: string) => Promise<void>,
  cleanup: Cleanup,
  warn: Warn,
): Promise<ImportSource> {
  try {
    await extract(fromPath, temporaryDirectory)
  } catch (error) {
    await cleanup(temporaryDirectory).catch(warn)
    throw error
  }

  return { path: temporaryDirectory, temporaryDirectory }
}

export async function useImportSource<T>(
  source: ImportSource,
  importSource: (path: string) => Promise<T>,
  cleanup: Cleanup,
  warn: Warn,
) {
  try {
    return await importSource(source.path)
  } finally {
    if (source.temporaryDirectory) {
      await cleanup(source.temporaryDirectory).catch(warn)
    }
  }
}
