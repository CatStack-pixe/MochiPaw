import { readFile } from '@tauri-apps/plugin-fs'

const DEFAULT_FONT_FAMILY = ''
const loadedFontFaces = new Map<string, FontFace>()

/**
 * Read a font file from disk and register it with the document via the FontFace API.
 * The font is identified by `familyName` and will replace any previously loaded
 * font registered under the same name.
 */
export async function loadCustomFont(path: string, familyName: string) {
  const buffer = await readFile(path)
  const existing = loadedFontFaces.get(familyName)

  if (existing) {
    document.fonts.delete(existing)
    loadedFontFaces.delete(familyName)
  }

  const fontFace = new FontFace(familyName, buffer)

  await fontFace.load()
  document.fonts.add(fontFace)
  loadedFontFaces.set(familyName, fontFace)
}

/**
 * Apply a font-family to the document root element.
 * Passing `undefined` or an empty string clears the override and restores the default.
 */
export function applyFontFamily(family: string | undefined) {
  if (!family) {
    document.documentElement.style.removeProperty('font-family')
    return
  }

  document.documentElement.style.setProperty('font-family', `"${family}", inherit`)
}

/**
 * Initialise the custom font on app startup.
 * If both `fontPath` and `fontFamily` are provided the font file is loaded and applied.
 */
export async function initCustomFont(fontPath?: string, fontFamily?: string) {
  if (!fontPath || !fontFamily) {
    applyFontFamily(undefined)
    return
  }

  try {
    await loadCustomFont(fontPath, fontFamily)
    applyFontFamily(fontFamily)
  } catch {
    applyFontFamily(DEFAULT_FONT_FAMILY)
  }
}

/**
 * Derive a human-readable font family name from a file path.
 * Uses the file name without its extension.
 */
export function getFontFamilyFromPath(path: string) {
  const fileName = path.split(/[\\/]/).at(-1) ?? path

  return fileName.replace(/\.[^.]+$/, '')
}
