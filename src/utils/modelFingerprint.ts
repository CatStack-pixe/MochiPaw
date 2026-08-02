// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export interface CubismResourceReference {
  key: string
  path: string
}

export interface CubismModelReferences {
  Moc?: string
  Textures?: string[]
  Physics?: string
  DisplayInfo?: string
  Expressions?: Array<{ File?: string }>
  Motions?: Record<string, Array<{ File?: string, Sound?: string }>>
  Pose?: string
  UserData?: string
}

export interface CubismModelDocument {
  FileReferences?: CubismModelReferences
}

export const CUBISM_FINGERPRINT_VERSION = 'v2'

/** Collect every file whose content contributes to a Cubism model identity. */
export function collectCubismResourceReferences(
  modelFile: string,
  modelJSON: CubismModelDocument,
): CubismResourceReference[] {
  const modelPath = modelFile.replace(/[\\/][^\\/]*$/, '')
  const modelName = modelFile.split(/[\\/]/).at(-1) ?? 'model3.json'
  const references = modelJSON.FileReferences
  const files: CubismResourceReference[] = [{
    key: `model:${modelName}`,
    path: modelFile,
  }]

  const add = (type: string, path?: string) => {
    if (!path) return
    files.push({ key: `${type}:${path}`, path: joinResourcePath(modelPath, path) })
  }

  add('moc', references?.Moc)
  add('physics', references?.Physics)
  add('displayInfo', references?.DisplayInfo)
  add('pose', references?.Pose)
  add('userData', references?.UserData)

  for (const texture of references?.Textures ?? []) add('texture', texture)
  for (const expression of references?.Expressions ?? []) add('expression', expression.File)
  for (const [group, motions] of Object.entries(references?.Motions ?? {})) {
    for (const motion of motions ?? []) {
      add(`motion:${group}`, motion.File)
      add(`motionSound:${group}`, motion.Sound)
    }
  }

  return files
}

export function isCurrentCubismFingerprint(value: string | undefined) {
  return value?.startsWith(`${CUBISM_FINGERPRINT_VERSION}:`) ?? false
}

export async function resolveCubismFingerprint(
  cached: string | undefined,
  calculate: () => Promise<string>,
) {
  if (isCurrentCubismFingerprint(cached)) return cached

  return await calculate()
}

export async function createCubismFingerprint(
  mode: string,
  references: CubismResourceReference[],
  readResource: (path: string) => Promise<Uint8Array | undefined>,
) {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let totalLength = 0

  for (const resource of references) {
    const keyBytes = encoder.encode(resource.key)
    chunks.push(keyBytes)
    totalLength += keyBytes.length

    const bytes = await readResource(resource.path)
    if (!bytes) continue

    chunks.push(bytes)
    totalLength += bytes.length
  }

  const input = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    input.set(chunk, offset)
    offset += chunk.length
  }

  const digest = await crypto.subtle.digest('SHA-256', input)
  const hash = [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')

  return `${CUBISM_FINGERPRINT_VERSION}:${mode}:${hash}`
}

function joinResourcePath(directory: string, resource: string) {
  const separator = directory.includes('\\') ? '\\' : '/'
  return `${directory.replace(/[\\/]$/, '')}${separator}${resource.replace(/^[\\/]+/, '')}`
}
