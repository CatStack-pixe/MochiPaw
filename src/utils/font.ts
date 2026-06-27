import { readFile, remove } from '@tauri-apps/plugin-fs'

const DEFAULT_FONT_FAMILY = ''
const loadedFontFaces = new Map<string, FontFace>()

/**
 * Read a font file from disk and register it with the document via the FontFace API.
 * Any previously loaded font (regardless of name) is unloaded first to prevent leaks.
 */
export async function loadCustomFont(path: string, familyName: string) {
  unloadAllFonts()

  const buffer = await readFile(path)
  const fontFace = new FontFace(familyName, buffer)

  await fontFace.load()
  document.fonts.add(fontFace)
  loadedFontFaces.set(familyName, fontFace)
}

/**
 * Remove a single loaded font face by name from the document and the cache.
 */
export function unloadFont(familyName: string) {
  const existing = loadedFontFaces.get(familyName)

  if (existing) {
    document.fonts.delete(existing)
    loadedFontFaces.delete(familyName)
  }
}

/**
 * Remove every loaded custom font face from the document and clear the cache.
 */
export function unloadAllFonts() {
  for (const fontFace of loadedFontFaces.values()) {
    document.fonts.delete(fontFace)
  }

  loadedFontFaces.clear()
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
    return false
  }

  try {
    await loadCustomFont(fontPath, fontFamily)
    applyFontFamily(fontFamily)
    return true
  } catch {
    applyFontFamily(DEFAULT_FONT_FAMILY)
    return false
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

/**
 * Delete a font file from disk. Errors (e.g. file not found) are silently
 * ignored so callers do not need extra error handling.
 */
export async function removeFontFile(path?: string) {
  if (!path) return

  try {
    await remove(path)
  } catch {
    // File may already have been deleted — ignore
  }
}
