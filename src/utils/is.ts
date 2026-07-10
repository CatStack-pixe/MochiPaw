// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

export function isImage(value: string) {
  const regex = /\.(?:jpe?g|png|webp|avif|gif|svg|bmp|ico|tiff?|heic|apng)$/i

  return regex.test(value)
}

export function inBetween(value: number, minimum: number, maximum: number) {
  return value >= minimum && value <= maximum
}
